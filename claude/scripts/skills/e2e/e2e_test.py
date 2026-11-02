"""End-to-end test of the real site in Chromium.

Serves the repo locally and answers the page's Supabase calls (anonymous auth +
/rest/v1/rpc/*) from a throwaway Postgres loaded with the base schema and all
migrations, so the actual main.js runs against the actual SQL functions.
Third-party scripts (ads, analytics, translate, maps) are blocked.

Usage:
  conda run --no-capture-output -n potluxy python claude/scripts/skills/e2e/e2e_test.py [--headed] [--port 8765] [--pg-port 54330]
"""
import argparse
import base64
import json
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psycopg
from psycopg import sql
from playwright.sync_api import expect, sync_playwright

REPO = Path(__file__).resolve().parents[4]
DB_TEST = Path(__file__).resolve().parents[1] / "db_test"
BLOCKED = re.compile(r"googletagmanager|googlesyndication|fundingchoicesmessages|translate\.google|nominatim|google-analytics")
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Content-Type": "application/json",
}


# ---------------------------------------------------------------- database
def start_db(tmp: Path, port: int) -> str:
    data = tmp / "db"
    subprocess.run(["initdb", "-D", str(data), "-U", "postgres", "-A", "trust"], check=True, capture_output=True)
    subprocess.run(["pg_ctl", "-D", str(data), "-o", f"-p {port} -k {tmp} -c listen_addresses=''",
                    "-l", str(tmp / "log"), "-w", "start"], check=True, capture_output=True)
    psql = ["psql", "-h", str(tmp), "-p", str(port), "-U", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1"]
    env = {"PGOPTIONS": "-c client_min_messages=warning"}
    run = lambda *a, **k: subprocess.run([*psql, *a], check=True, capture_output=True, env={**__import__("os").environ, **env}, **k)
    run("-d", "postgres", "-c", "CREATE DATABASE potluxy_test")
    run("-d", "potluxy_test", "-f", str(DB_TEST / "stub_supabase.sql"))
    base = (REPO / "code" / "supabase_config.sql").read_text()
    base = base.replace("CREATE POLICY IF NOT EXISTS", "CREATE POLICY")
    base = "\n".join(l for l in base.splitlines() if "pg_cron" not in l)
    run("-d", "potluxy_test", input=base.encode())
    for mig in sorted((REPO / "code" / "migrations").glob("*.sql")):
        run("-d", "potluxy_test", "-f", str(mig))
    return f"host={tmp} port={port} user=postgres dbname=potluxy_test"


def stop_db(tmp: Path):
    subprocess.run(["pg_ctl", "-D", str(tmp / "db"), "-m", "immediate", "stop"], capture_output=True)


def call_rpc(conn, fn: str, args: dict, sub: str | None):
    def lit(v):
        if v is None:
            return sql.SQL("NULL")
        if isinstance(v, bool):
            v = "true" if v else "false"
        elif isinstance(v, (dict, list)):
            v = json.dumps(v)
        return sql.Literal(str(v))

    params = sql.SQL(", ").join(sql.SQL("{} => {}").format(sql.Identifier(k), lit(v)) for k, v in args.items())
    query = sql.SQL("SELECT public.{}({})::text").format(sql.Identifier(fn), params)
    try:
        with conn.transaction(), conn.cursor() as cur:
            cur.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier("authenticated" if sub else "anon")))
            cur.execute("SELECT set_config('request.jwt.claim.sub', %s, true)", (sub or "",))
            cur.execute(query)
            value = cur.fetchone()[0]
        return 200, value if value is not None else "null"
    except psycopg.Error as e:
        return 400, json.dumps({"code": e.sqlstate, "message": e.diag.message_primary, "details": None, "hint": None})


# ---------------------------------------------------------------- fake auth
def b64(d: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()


def session_for(uid: str) -> dict:
    now = int(time.time())
    claims = {"sub": uid, "role": "authenticated", "aud": "authenticated", "exp": now + 3600,
              "iat": now, "is_anonymous": True, "session_id": uid}
    token = f"{b64({'alg': 'HS256', 'typ': 'JWT'})}.{b64(claims)}.sig"
    user = {"id": uid, "aud": "authenticated", "role": "authenticated", "is_anonymous": True,
            "app_metadata": {}, "user_metadata": {}, "identities": [], "created_at": "2026-01-01T00:00:00Z"}
    return {"access_token": token, "token_type": "bearer", "expires_in": 3600, "expires_at": now + 3600,
            "refresh_token": uid, "user": user}


def jwt_sub(auth_header: str | None) -> str | None:
    try:
        payload = (auth_header or "").split(" ", 1)[1].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return claims.get("sub") if claims.get("role") == "authenticated" else None
    except Exception:
        return None


def install_mocks(context, supabase_url: str, conn):
    def handle(route, request):
        path = request.url[len(supabase_url):].split("?")[0]
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        if path == "/auth/v1/signup":
            return route.fulfill(status=200, headers=CORS, body=json.dumps(session_for(str(uuid.uuid4()))))
        if path == "/auth/v1/token":
            body = json.loads(request.post_data or "{}")
            return route.fulfill(status=200, headers=CORS, body=json.dumps(session_for(body.get("refresh_token") or str(uuid.uuid4()))))
        m = re.fullmatch(r"/rest/v1/rpc/(\w+)", path)
        if m:
            status, body = call_rpc(conn, m.group(1), json.loads(request.post_data or "{}"), jwt_sub(request.headers.get("authorization")))
            return route.fulfill(status=status, headers=CORS, body=body)
        if path.startswith("/functions/v1/"):
            return route.fulfill(status=200, headers=CORS, body=json.dumps({"ok": True, "sent": 0}))
        return route.fulfill(status=404, headers=CORS, body=json.dumps({"message": f"not mocked: {path}"}))

    context.route(re.compile(re.escape(supabase_url) + ".*"), handle)
    context.route(BLOCKED, lambda route: route.abort())


# ---------------------------------------------------------------- scenario
def run_scenario(browser, base_url: str, supabase_url: str, conn):
    errors: list[str] = []
    dialogs: list[str] = []

    def new_page():
        ctx = browser.new_context()
        install_mocks(ctx, supabase_url, conn)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
        return page

    def ok(label):
        print(f"  pass: {label}")

    def card(page, item):
        return page.locator(".commitment-card", has_text=item)

    # Host creates an event (no password) with a tag-like name.
    host = new_page()
    host.goto(base_url)
    host.fill("#eventName", "Friendsgiving <b>2026</b>")
    host.fill("#username", "Alex")
    host.check("#collectEmails")
    host.click("#createEventBtn")
    expect(host.locator(".event-title")).to_have_text("Friendsgiving <b>2026</b>")
    ok("host creates event; HTML in name shown as text")
    expect(host.locator("#pwdNudge")).to_be_visible()
    ok("passwordless host sees gentle password nudge")

    for name, qty in [("Pie", "2"), ("Rolls", "3")]:
        host.fill("#newItemName", name)
        host.fill("#newItemQuantity", qty)
        host.click("#addItemForm button[type=submit]")
        expect(host.locator(f"#itemList input[value='{name}']")).to_have_count(1)
    ok("host adds items")
    url = host.input_value("#shareUrl")

    # Guest joins with email + password and commits.
    guest = new_page()
    guest.goto(url)
    expect(guest.locator(".item-card", has_text="Pie")).to_contain_text("0 of 2 covered")
    ok("visitor sees items before responding")
    guest.click("#chooseYes")
    guest.fill("#yesName", "Dana")
    guest.fill("#yesEmail", "dana@example.com")
    guest.fill("#yesPwd", "pw1234")
    guest.click("#rsvpYesForm button[type=submit]")
    expect(guest.get_by_text("Responding as")).to_contain_text("Dana")
    expect(guest.locator("#pwdNudge")).to_have_count(0)
    ok("guest joins with password (no nudge)")
    card(guest, "Pie").locator("input").fill("1")
    card(guest, "Pie").locator("button").click()
    expect(card(guest, "Pie")).to_contain_text("Your Commitment: 1")
    card(guest, "Rolls").locator("input").fill("9")
    card(guest, "Rolls").locator("button").click()
    expect(guest.locator("#commitErr")).to_contain_text("Only 3 more")
    ok("guest commits; over-commit rejected with message")

    # Attacker tries to take names.
    attacker = new_page()
    attacker.goto(url)
    attacker.click("#chooseYes")
    attacker.fill("#yesName", "alex")
    attacker.fill("#yesEmail", "x@y.co")
    attacker.click("#rsvpYesForm button[type=submit]")
    expect(attacker.locator("#yesErr")).to_contain_text("without a password")
    ok("cannot hijack passwordless host name")
    attacker.fill("#yesName", "Dana")
    attacker.fill("#yesPwd", "guess")
    attacker.click("#rsvpYesForm button[type=submit]")
    expect(attacker.locator("#yesErr")).to_contain_text("didn't match")
    ok("cannot hijack password-protected name")
    xss_name = "<img src=x onerror=window.__x=1>"
    attacker.fill("#yesName", xss_name)
    attacker.fill("#yesPwd", "")
    attacker.fill("#yesEmail", "evil@x.co")
    attacker.click("#rsvpYesForm button[type=submit]")
    expect(attacker.get_by_text("Responding as")).to_be_visible()

    host.reload()
    expect(host.locator(".creator-summary")).to_contain_text("dana@example.com")
    expect(host.locator(".creator-summary")).to_contain_text(xss_name)
    assert host.evaluate("window.__x") is None, "XSS payload executed on host page"
    ok("host sees guest emails; script-like names are inert")
    guest.reload()
    expect(guest.get_by_text("Responding as")).to_contain_text("Dana")
    assert "evil@x.co" not in guest.content() and "dana@example.com" not in guest.content()
    ok("guests never receive email addresses")

    # Decline with a message.
    decliner = new_page()
    decliner.goto(url)
    decliner.click("#chooseNo")
    decliner.fill("#noName", "Sam")
    decliner.fill("#noMsg", "Out of town")
    decliner.click("#rsvpNoForm button[type=submit]")
    expect(decliner.get_by_text("Responding as")).to_contain_text("(not going)")
    host.reload()
    expect(host.locator(".creator-summary")).to_contain_text("Out of town")
    ok("decline + message reaches host only")

    host.locator(f"[data-remove-guest='{xss_name}']").click()
    expect(host.locator(".creator-summary")).not_to_contain_text("evil@x.co")
    ok("host removes a guest")

    # Dana signs in from another browser by email + password.
    other = new_page()
    other.goto(url)
    other.click("#chooseAlready")
    other.fill("#loginIdent", "dana@example.com")
    other.fill("#loginPwd", "pw1234")
    other.click("#loginForm button[type=submit]")
    expect(card(other, "Pie")).to_contain_text("Your Commitment: 1")
    ok("returning guest signs in elsewhere and sees their commitment")
    other.click("#signOutBtn")
    expect(other.locator("#chooseYes")).to_be_visible()
    ok("sign out")

    # Host management.
    host.click("#editEventBtn")
    host.fill("#editEventName", "Friendsgiving 2026")
    host.click("#saveEventChanges")
    expect(host.locator(".event-title")).to_have_text("Friendsgiving 2026")
    ok("host edits event")
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
        f.write("item_name,quantity_required,item_description\nPie,4,\nCranberry sauce,1,homemade ok\n")
    host.set_input_files("#importCSVInput", f.name)
    expect(host.locator("#itemList .item-card")).to_have_count(3)
    expect(host.locator("#itemList input[value='Pie'] + input")).to_have_value("4")
    ok("CSV import updates + adds items")
    host.click("#deleteEventBtn")
    host.click("#confirmDel")
    expect(host.get_by_text("scheduled for deletion")).to_be_visible()
    host.click("#undeleteEventBtn")
    host.click("#confirmDel")
    expect(host.get_by_text("scheduled for deletion")).to_have_count(0)
    ok("host deletes and undoes")
    host.click("#showPwdForm")
    host.fill("#newPwd", "hostpw")
    host.click("#pwdForm button[type=submit]")
    expect(host.locator("#pwdNudge")).to_have_count(0)
    ok("host adds a password from the nudge")

    # Bad link falls back to create form.
    stray = new_page()
    stray.goto(base_url + "/#/event/does-not-exist-123")
    expect(stray.locator("#eventFormError")).to_contain_text("not found")
    ok("unknown event link handled")

    assert not errors, f"Uncaught page errors: {errors}"
    ok("no uncaught JavaScript errors")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true", help="show the browser")
    ap.add_argument("--port", type=int, default=8765, help="static site port")
    ap.add_argument("--pg-port", type=int, default=54330, help="local Postgres port")
    args = ap.parse_args()

    supabase_url = re.search(r'SUPABASE_URL\s*=\s*"([^"]+)"', (REPO / "config.js").read_text()).group(1)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(type("Quiet", (SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=str(REPO)))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        try:
            dsn = start_db(tmp, args.pg_port)
            with psycopg.connect(dsn, autocommit=True) as conn, sync_playwright() as pw:
                browser = pw.chromium.launch(headless=not args.headed)
                run_scenario(browser, f"http://127.0.0.1:{args.port}", supabase_url, conn)
                browser.close()
            print("ALL E2E TESTS PASSED")
        except subprocess.CalledProcessError as e:
            sys.exit(f"DB setup failed: {e.stderr.decode(errors='replace')[-2000:]}")
        finally:
            stop_db(tmp)
            server.shutdown()


if __name__ == "__main__":
    main()
