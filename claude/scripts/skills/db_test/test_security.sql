-- Security + behavior tests for the RPC API. Runs as superuser, switching roles
-- with SET ROLE and "logging in" by setting the JWT sub claim.
\set ON_ERROR_STOP 1
\set QUIET 1

CREATE SCHEMA IF NOT EXISTS t;
GRANT USAGE ON SCHEMA t TO anon, authenticated;

CREATE OR REPLACE FUNCTION t.login(p uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', COALESCE(p::text, ''), false)
$$;
CREATE OR REPLACE FUNCTION t.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'pass: %', label;
END $$;
CREATE OR REPLACE FUNCTION t.err(q text, pattern text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE q;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE pattern THEN RAISE NOTICE 'pass: %', label; RETURN; END IF;
    RAISE EXCEPTION 'FAIL: % (wrong error: %)', label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL: % (no error raised)', label;
END $$;
-- Returns the "error" field of a jsonb RPC result (wrong-password style failures).
CREATE OR REPLACE FUNCTION t.rpc_error(q text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN EXECUTE q INTO r; RETURN r->>'error'; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO anon, authenticated;

-- ---- Legacy migration (as superuser) --------------------------------------
SELECT t.ok((SELECT count(*) FROM auth.users WHERE email ILIKE '%mailinator%') = 0, 'mailinator alias logins neutralized');
SELECT t.ok((SELECT count(*) FROM private.member_credentials) = 1, 'only real passwords migrated (Jane yes, Bob''s default no)');
SELECT t.ok((SELECT count(*) FROM private.member_sessions) = 2, 'existing browser sessions kept for Jane and Bob');

-- ---- Anonymous visitor ----------------------------------------------------
SET ROLE anon;
SELECT t.login(NULL);
SELECT t.err('SELECT * FROM public.events', '%permission denied%', 'anon cannot list events');
SELECT t.err('SELECT * FROM public.event_users', '%permission denied%', 'anon cannot read attendee table');
SELECT t.err('SELECT public.join_event(''legacy-abc'', ''{"name":"X1"}'')', '%permission denied%', 'anon cannot write');
SELECT t.ok(public.get_event('legacy-abc')->'event'->>'name' = 'Legacy Friendsgiving', 'anon can view event by slug');
SELECT t.ok(NOT (public.get_event('legacy-abc') ? 'guests'), 'anon does not get guest emails');
SELECT t.ok(public.get_event('legacy-abc')::text NOT ILIKE '%@example.com%', 'no email anywhere in public view');
SELECT t.err('SELECT public.get_event(''nope'')', '%not found%', 'unknown slug errors');
RESET ROLE;

-- ---- Existing host keeps access ------------------------------------------
SET ROLE authenticated;
SELECT t.login('aaaaaaaa-0000-0000-0000-000000000001');
SELECT t.ok((public.get_event('legacy-abc')->'me'->>'is_host')::boolean, 'legacy host session still recognized');
SELECT t.ok(public.get_event('legacy-abc')::text ILIKE '%bob@example.com%', 'host sees guest emails');
SELECT t.err('SELECT public.update_me(''legacy-abc'', ''{"rsvp":"no"}'')', '%always marked as going%', 'host cannot RSVP no');

-- ---- Takeover attempts ----------------------------------------------------
SELECT t.login('cccccccc-0000-0000-0000-000000000001');
SELECT t.ok(public.get_event('legacy-abc')->'me' = 'null'::jsonb, 'stranger is nobody');
SELECT t.ok(t.rpc_error('SELECT public.join_event(''legacy-abc'', ''{"name":"jane_doe"}'')') ILIKE '%password didn''t match%', 'cannot claim host name without password');
SELECT t.ok(t.rpc_error('SELECT public.join_event(''legacy-abc'', ''{"name":"Bob","email":"x@y.co"}'')') ILIKE '%without a password%', 'cannot claim passwordless name');
SELECT t.ok(t.rpc_error('SELECT public.sign_in(''legacy-abc'', ''Jane_Doe'', ''no-password'')') IS NOT NULL, 'old default password rejected');
SELECT t.err('SELECT public.host_save_item(''legacy-abc'', NULL, ''Hack'', 1, NULL)', '%only the host%', 'stranger cannot add items');
SELECT t.err('SELECT public.host_set_deleted(''legacy-abc'', true)', '%only the host%', 'stranger cannot delete event');
SELECT t.err('SELECT public.potluxy_nightly_maintenance(interval ''0'', 250, 5000, false)', '%permission denied%', 'maintenance not callable');
SELECT t.err('SELECT public.rsvp_yes_claim(gen_random_uuid(), ''x'', NULL)', '%does not exist%', 'old claim function removed');

-- Correct password from a new browser works.
SELECT t.ok((public.sign_in('legacy-abc', 'Jane_Doe', 'secret1')->'me'->>'is_host')::boolean, 'host can sign in elsewhere with password');

-- ---- New guest flow --------------------------------------------------------
SELECT t.login('dddddddd-0000-0000-0000-000000000001');
SELECT t.err('SELECT public.join_event(''legacy-abc'', ''{"name":"Dana"}'')', '%asked for an email%', 'email required when host asks');
SELECT t.ok(public.join_event('legacy-abc', '{"name":"Dana","email":"Dana@Example.com","password":"pw1234"}')->'me'->>'name' = 'Dana', 'guest joins');
SELECT t.ok(NOT (public.get_event('legacy-abc') ? 'guests'), 'guest does not see other emails');
SELECT t.err('SELECT public.set_commitment(''11111111-0000-0000-0000-000000000001'', 2)', '%Only 1 more%', 'cannot over-commit');
SELECT t.ok((SELECT (i->>'mine')::int FROM jsonb_array_elements(public.set_commitment('11111111-0000-0000-0000-000000000001', 1)->'items') i) = 1, 'guest commits 1 pie');
SELECT t.err('SELECT public.join_event(''legacy-abc'', ''{"name":"Eve","email":"dana@example.com"}'')', '%already used that email%', 'one email per guest');

-- ---- Lockout ---------------------------------------------------------------
SELECT t.login('dddddddd-0000-0000-0000-000000000002');
SELECT t.rpc_error('SELECT public.sign_in(''legacy-abc'', ''Dana'', ''wrong'')') FROM generate_series(1, 5);
SELECT t.ok(t.rpc_error('SELECT public.sign_in(''legacy-abc'', ''Dana'', ''pw1234'')') ILIKE '%Too many%', 'locked after 5 wrong passwords, even with the right one');

-- ---- Decline + host view --------------------------------------------------
SELECT t.login('dddddddd-0000-0000-0000-000000000003');
SELECT t.ok((public.join_event('legacy-abc', '{"name":"Riley","rsvp":"no","message":"Out of town"}')->>'not_going_count')::int = 2, 'decline counted');
SELECT t.login('aaaaaaaa-0000-0000-0000-000000000001');
SELECT t.ok(public.get_event('legacy-abc')::text ILIKE '%Out of town%', 'host sees decline message');
SELECT t.ok(public.host_remove_guest('legacy-abc', 'riley')::text NOT ILIKE '%Riley%', 'host removes a guest');
SELECT t.err('SELECT public.host_save_item(''legacy-abc'', ''11111111-0000-0000-0000-000000000001'', ''Pie'', 1, NULL)', '%below existing commitments%', 'cannot shrink below commitments');
SELECT t.ok(public.host_import_items('legacy-abc', '[{"name":"pie","needed":5},{"name":"Rolls","needed":"3"}]')->'items' @> '[{"name":"pie","needed":5},{"name":"Rolls","needed":3}]', 'CSV import updates + inserts');
SELECT t.ok((public.host_set_deleted('legacy-abc', true)->'event'->>'deleting')::boolean, 'host schedules deletion');
SELECT t.login('dddddddd-0000-0000-0000-000000000004');
SELECT t.err('SELECT public.join_event(''legacy-abc'', ''{"name":"Late","email":"l@x.co"}'')', '%scheduled for deletion%', 'no joins while deleting');
SELECT t.login('aaaaaaaa-0000-0000-0000-000000000001');
SELECT t.ok(NOT (public.host_set_deleted('legacy-abc', false)->'event'->>'deleting')::boolean, 'host undoes deletion');

-- ---- New event -------------------------------------------------------------
SELECT t.login('ffffffff-0000-0000-0000-000000000001');
SELECT public.create_event('{"name":"Thanksgiving 2026!","host_name":"Alex","date":"2026-11-26","time":"16:00","invite_url":"https://partiful.com/e/abc"}')->>'slug' AS new_slug \gset
SELECT t.ok(:'new_slug' ~ '^thanksgiving-2026-[0-9a-f]{12}$', 'slug has 48-bit random suffix');
SELECT t.ok((public.get_event(:'new_slug')->'me'->>'has_password')::boolean = false, 'passwordless host flagged');
SELECT t.ok(public.get_event(:'new_slug')->'event'->>'time' = '16:00', 'time formatted');
SELECT t.err('SELECT public.create_event(''{"name":"x","host_name":"Al","invite_url":"javascript:alert(1)"}'')', '%https://%', 'non-https invite links rejected');
SELECT t.err('SELECT public.create_event(''{"name":"x","host_name":"Al","password":"abc"}'')', '%4 to 72%', 'short password rejected');
SELECT t.ok((public.update_me(:'new_slug', '{"password":"newpass"}')->'me'->>'has_password')::boolean, 'host adds password later');
SELECT t.ok(t.rpc_error(format('SELECT public.update_me(%L, ''{"password":"other1","current_password":"bad"}'')', :'new_slug')) ILIKE '%incorrect%', 'changing password needs current one');

RESET ROLE;
\echo ALL TESTS PASSED
