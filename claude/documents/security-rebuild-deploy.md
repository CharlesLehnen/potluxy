# Deploying the security rebuild (2026-11-02)

The old site reads tables directly; the new site only calls database functions.
Once the migration runs, the old site stops working, and the new site needs the migration.
Do steps 3–4 back to back; expect a minute or two where the live site errors.

## 0. Before you start (optional but recommended)
- Make the GitHub repo **private** until step 4 is done; the old schema file shows the holes.
- Test locally (both should end with "ALL ... PASSED"):
  ```bash
  claude/scripts/skills/db_test/run_db_tests.sh
  conda run --no-capture-output -n potluxy python claude/scripts/skills/e2e/e2e_test.py
  ```

## 1. Supabase dashboard settings
- **Authentication → Sign In / Providers → Allow anonymous sign-ins: ON.**
  Every visitor gets a private browser session; that is their identity.
- **Authentication → Rate Limits → anonymous sign-ins per hour:** raise from the default (30 per IP)
  to around **300**. Guests on the same Wi-Fi (an office potluck) share one IP.
- Leave the Email provider as it is. The migration already makes the old mailinator logins unusable.

## 2. Commit (don't push yet)
Commit everything, but wait to push until step 3 is done.

## 3. Run the migration
Supabase → **SQL Editor** → paste all of `code/migrations/2026-11-02_security_rebuild.sql` → **Run**.
It runs in one transaction: if anything fails, nothing changes. It is safe to re-run.

## 4. Push immediately
`git push` → GitHub Pages redeploys in about a minute. Hard-refresh the site (Ctrl+Shift+R).

## 5. Redeploy the reminder email function
The function now checks that the caller is the host. Either:
- Dashboard → **Edge Functions → send-reminders → Edit** → paste `code/send-reminders.ts` → Deploy, or
- CLI: `supabase functions deploy send-reminders`

It uses the built-in `SUPABASE_ANON_KEY` secret, which Supabase provides automatically.

## 6. Verify
Ask Claude to "re-run the live security probes". It should find:
- listing events / attendees / emails → **permission denied**
- the old `rsvp_yes_claim` function → **not found**

Then click through manually: create an event, open the link in a private window, RSVP, commit an item.

## What existing users will notice
- People who set a password: nothing changes; their password still works.
- People without a password: still work **in the same browser** they used before.
  From another device they can't reclaim that name (that's the fix). They can pick a new name.
- Hosts without a password see a small note offering to add one.

## Git history: nothing to rewrite
- The vulnerabilities lived in the **live database rules**, not in a secret. Running the migration
  fixes them; rewriting history wouldn't help (and the old schema was already public).
- A history scan found only Supabase **anon** keys, which are public by design, and placeholder text.
- One leftover: a Firebase web API key (`AIzaSyCuG4…`) in `register.js` from the
  Sept 2024 Firebase experiment. Firebase web keys aren't secret either, but if that Firebase project
  still exists: Google Cloud Console → APIs & Services → Credentials → delete the key, or delete
  the unused project. No history rewrite needed.
