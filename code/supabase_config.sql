-- ============================================================================
-- Potluxy database schema: COMPLETE CURRENT STATE (fresh install)
--
-- This file describes the whole database as if it had been built this way from
-- the start. It is kept in sync with every file in code/migrations/:
--   * New database  → run this file once in the Supabase SQL editor.
--   * Existing (production) database → run only the new migration files.
-- claude/scripts/skills/db_test/run_db_tests.sh fails if this file and
-- "archive/supabase_config_original_2025.sql + all migrations" ever differ.
--
-- Before first use: Dashboard → Authentication → enable anonymous sign-ins.
--
-- Security model
--   * Browsers never touch tables directly (RLS on, no policies, privileges
--     revoked). Everything goes through the SECURITY DEFINER functions in the
--     "Public API" section, which check who is calling.
--   * Each browser gets a Supabase anonymous session; private.member_sessions
--     links that session to one guest per event.
--   * Identity works like when2meet: a name + optional password.
--       - no password → only the browser that responded can edit
--       - password    → sign back in from anywhere (bcrypt; 5 wrong tries
--                       lock that name for 15 minutes)
--   * Events can only be fetched by their unguessable slug; guest emails and
--     decline messages are visible to the host only.
--
-- Deletion model
--   * events.delete_requested_at is the canonical deletion flag (host can undo)
--   * clients never hard-delete events; potluxy_nightly_maintenance() purges
--     them after a grace window (see code/delete_events_schedule.sql)
-- ============================================================================

-- 0) Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- Optional (needed only if you will schedule DB cron jobs from Postgres)
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- --------------------------------------------
-- 1) EVENTS
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_description TEXT,
  event_date DATE,
  event_time TIME,

  -- optional location fields
  event_location TEXT,
  event_place_id TEXT,
  event_lat DOUBLE PRECISION,
  event_lng DOUBLE PRECISION,

  -- email-reminder controls
  collect_real_emails BOOLEAN NOT NULL DEFAULT false,
  last_reminder_sent_at TIMESTAMPTZ,
  reminder_window_count INTEGER NOT NULL DEFAULT 0,

  -- deletion (canonical)
  -- if NOT NULL, event is scheduled for deletion by backend job after grace window
  delete_requested_at TIMESTAMPTZ,

  -- optional links shown on the event page (https only; see private.clean_url)
  invite_url TEXT,     -- Partiful / Evite invite
  schedule_url TEXT    -- when2meet or similar "find a time" poll
);

-- Index to support purge/maintenance queries
CREATE INDEX IF NOT EXISTS events_delete_requested_at_idx
  ON public.events (delete_requested_at);

-- --------------------------------------------
-- 2) EVENT ITEMS
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  quantity_required INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  item_description TEXT,
  UNIQUE(event_id, item_name)
);

-- --------------------------------------------
-- 3) EVENT_USERS (per-event identity)
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_users (
  id UUID PRIMARY KEY, -- random; browsers are linked to it via private.member_sessions
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- attendee's real email for THIS event
  real_email TEXT,

  -- reminders opt-out
  wants_reminders BOOLEAN NOT NULL DEFAULT true,

  -- RSVP (+ decline fields)
  rsvp_status TEXT NOT NULL DEFAULT 'yes',
  decline_message TEXT,
  decline_at TIMESTAMPTZ,

  UNIQUE(event_id, username),
  CONSTRAINT event_users_rsvp_status_chk CHECK (rsvp_status IN ('yes','no'))
);

-- keep emails unique PER event (NULLs allowed)
CREATE UNIQUE INDEX IF NOT EXISTS event_users_event_id_real_email_idx
  ON public.event_users (event_id, real_email)
  WHERE real_email IS NOT NULL;

-- case-insensitive uniqueness helper for (event_id, username)
CREATE UNIQUE INDEX IF NOT EXISTS event_users_event_id_lower_username_uniq
  ON public.event_users (event_id, lower(username));

-- creator views segmented by RSVP (partial)
CREATE INDEX IF NOT EXISTS event_users_event_id_status_idx
  ON public.event_users (event_id, rsvp_status)
  WHERE rsvp_status IS NOT NULL;

-- convenience indices
CREATE INDEX IF NOT EXISTS event_users_event_id_idx
  ON public.event_users(event_id);

CREATE INDEX IF NOT EXISTS event_users_event_id_rsvp_idx
  ON public.event_users(event_id, rsvp_status);

-- --------------------------------------------
-- 4) COMMITMENTS
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS public.commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.event_users(id) ON DELETE SET NULL,
  item_id UUID NOT NULL REFERENCES public.event_items(id) ON DELETE CASCADE,
  quantity INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(event_id, user_id, item_id)
);

-- --------------------------------------------
-- Lock the tables: no direct client access at all
-- --------------------------------------------
ALTER TABLE public.events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_users  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commitments  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.events, public.event_items, public.event_users, public.commitments
  FROM PUBLIC, anon, authenticated;

-- --------------------------------------------
-- Data rules (triggers)
-- --------------------------------------------

-- Prevent reducing item.required below current commitments
CREATE OR REPLACE FUNCTION public.prevent_reduce_below_commitment()
RETURNS TRIGGER AS $$
DECLARE total_committed INT;
BEGIN
  SELECT COALESCE(SUM(quantity), 0) INTO total_committed
  FROM public.commitments WHERE item_id = NEW.id;

  IF NEW.quantity_required < total_committed THEN
    RAISE EXCEPTION 'Cannot reduce required quantity below existing commitments (%).', total_committed;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_reduce_below_commitment_trigger ON public.event_items;
CREATE TRIGGER prevent_reduce_below_commitment_trigger
BEFORE UPDATE ON public.event_items
FOR EACH ROW
EXECUTE FUNCTION public.prevent_reduce_below_commitment();

-- Server-side cap: total committed for an item may not exceed required (insert/update)
CREATE OR REPLACE FUNCTION public.enforce_commitment_cap()
RETURNS TRIGGER AS $$
DECLARE req INT;
DECLARE current_sum INT;
DECLARE prior INT := 0;
BEGIN
  SELECT quantity_required INTO req FROM public.event_items WHERE id = NEW.item_id;
  IF req IS NULL THEN
    RAISE EXCEPTION 'Unknown item_id %', NEW.item_id;
  END IF;

  SELECT COALESCE(SUM(quantity),0) INTO current_sum
  FROM public.commitments
  WHERE item_id = NEW.item_id;

  IF TG_OP = 'UPDATE' THEN
    SELECT COALESCE(quantity,0) INTO prior FROM public.commitments WHERE id = OLD.id;
  END IF;

  IF (current_sum - prior + NEW.quantity) > req THEN
    RAISE EXCEPTION 'Cannot commit %, only % slot(s) available.',
      NEW.quantity, GREATEST(req - (current_sum - prior), 0);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_commitment_cap ON public.commitments;
CREATE TRIGGER enforce_commitment_cap
BEFORE INSERT OR UPDATE ON public.commitments
FOR EACH ROW
EXECUTE FUNCTION public.enforce_commitment_cap();

-- Disallow changing a guest's id, event, or name
CREATE OR REPLACE FUNCTION public.lock_event_users_keys()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'Guest identity cannot be changed.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lock_event_users_keys ON public.event_users;
CREATE TRIGGER lock_event_users_keys
BEFORE UPDATE ON public.event_users
FOR EACH ROW
EXECUTE FUNCTION public.lock_event_users_keys();

-- Force creators to remain RSVP 'yes' (cannot flip to 'no')
CREATE OR REPLACE FUNCTION public.enforce_creator_yes()
RETURNS trigger AS $$
DECLARE is_creator BOOLEAN;
BEGIN
  SELECT (e.created_by = NEW.username) INTO is_creator
  FROM public.events e
  WHERE e.id = NEW.event_id;

  IF is_creator THEN
    NEW.rsvp_status := 'yes';
    NEW.wants_reminders := COALESCE(NEW.wants_reminders, TRUE);
    NEW.decline_message := NULL;
    NEW.decline_at := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_creator_yes_ins ON public.event_users;
DROP TRIGGER IF EXISTS enforce_creator_yes_upd ON public.event_users;

CREATE TRIGGER enforce_creator_yes_ins
BEFORE INSERT ON public.event_users
FOR EACH ROW
EXECUTE FUNCTION public.enforce_creator_yes();

CREATE TRIGGER enforce_creator_yes_upd
BEFORE UPDATE ON public.event_users
FOR EACH ROW
EXECUTE FUNCTION public.enforce_creator_yes();

-- ============================================================
-- Nightly maintenance: purge old delete_requested events + defensive cleanup
-- ============================================================
CREATE OR REPLACE FUNCTION public.potluxy_nightly_maintenance(
  p_grace interval default interval '7 days',
  p_max_events integer default 250,
  p_max_bad integer default 5000,
  p_dry_run boolean default true
)
RETURNS TABLE(metric text, affected bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_candidates_events bigint := 0;
  v_deleted_events bigint := 0;

  v_candidates_bad_commitments bigint := 0;
  v_candidates_orphan_items bigint := 0;
  v_candidates_orphan_users bigint := 0;

  v_deleted_bad_commitments bigint := 0;
  v_deleted_orphan_items bigint := 0;
  v_deleted_orphan_users bigint := 0;
BEGIN
  -- (A) Events eligible for hard deletion: explicitly marked + older than grace window
  SELECT count(*)
    INTO v_candidates_events
  FROM public.events e
  WHERE e.delete_requested_at IS NOT NULL
    AND e.delete_requested_at < now() - p_grace;

  IF v_candidates_events > p_max_events THEN
    RAISE EXCEPTION
      'Safety stop: % events eligible, exceeds p_max_events=%. Investigate.',
      v_candidates_events, p_max_events;
  END IF;

  IF NOT p_dry_run THEN
    WITH to_delete AS (
      SELECT e.id
      FROM public.events e
      WHERE e.delete_requested_at IS NOT NULL
        AND e.delete_requested_at < now() - p_grace
      ORDER BY e.delete_requested_at ASC
      LIMIT p_max_events
    )
    DELETE FROM public.events e
    USING to_delete d
    WHERE e.id = d.id;

    GET DIAGNOSTICS v_deleted_events = ROW_COUNT;
  END IF;

  -- (B) Defensive cleanup for inconsistent data (should be ~0 with your FKs/cascades)
  -- "Bad commitments" are any commitment rows that reference:
  --   - a missing event, or
  --   - a missing item, or
  --   - an item belonging to a different event, or
  --   - a non-null user_id that doesn't exist / belongs to a different event
  SELECT count(*)
    INTO v_candidates_bad_commitments
  FROM public.commitments c
  WHERE NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = c.event_id)
     OR NOT EXISTS (SELECT 1 FROM public.event_items i WHERE i.id = c.item_id)
     OR EXISTS (
          SELECT 1 FROM public.event_items i
          WHERE i.id = c.item_id AND i.event_id IS DISTINCT FROM c.event_id
        )
     OR (
          c.user_id IS NOT NULL AND (
            NOT EXISTS (SELECT 1 FROM public.event_users u WHERE u.id = c.user_id)
            OR EXISTS (
                 SELECT 1 FROM public.event_users u
                 WHERE u.id = c.user_id AND u.event_id IS DISTINCT FROM c.event_id
               )
          )
        );

  IF v_candidates_bad_commitments > p_max_bad THEN
    RAISE EXCEPTION
      'Safety stop: % bad commitments exceeds p_max_bad=%. Investigate.',
      v_candidates_bad_commitments, p_max_bad;
  END IF;

  IF NOT p_dry_run THEN
    DELETE FROM public.commitments c
    WHERE NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = c.event_id)
       OR NOT EXISTS (SELECT 1 FROM public.event_items i WHERE i.id = c.item_id)
       OR EXISTS (
            SELECT 1 FROM public.event_items i
            WHERE i.id = c.item_id AND i.event_id IS DISTINCT FROM c.event_id
          )
       OR (
            c.user_id IS NOT NULL AND (
              NOT EXISTS (SELECT 1 FROM public.event_users u WHERE u.id = c.user_id)
              OR EXISTS (
                   SELECT 1 FROM public.event_users u
                   WHERE u.id = c.user_id AND u.event_id IS DISTINCT FROM c.event_id
                 )
            )
          );

    GET DIAGNOSTICS v_deleted_bad_commitments = ROW_COUNT;
  END IF;

  -- Orphan items (no event)
  SELECT count(*)
    INTO v_candidates_orphan_items
  FROM public.event_items i
  WHERE NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = i.event_id);

  IF v_candidates_orphan_items > p_max_bad THEN
    RAISE EXCEPTION
      'Safety stop: % orphan event_items exceeds p_max_bad=%. Investigate.',
      v_candidates_orphan_items, p_max_bad;
  END IF;

  IF NOT p_dry_run THEN
    DELETE FROM public.event_items i
    WHERE NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = i.event_id);

    GET DIAGNOSTICS v_deleted_orphan_items = ROW_COUNT;
  END IF;

  -- Orphan users (no event)
  SELECT count(*)
    INTO v_candidates_orphan_users
  FROM public.event_users u
  WHERE NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = u.event_id);

  IF v_candidates_orphan_users > p_max_bad THEN
    RAISE EXCEPTION
      'Safety stop: % orphan event_users exceeds p_max_bad=%. Investigate.',
      v_candidates_orphan_users, p_max_bad;
  END IF;

  IF NOT p_dry_run THEN
    DELETE FROM public.event_users u
    WHERE NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = u.event_id);

    GET DIAGNOSTICS v_deleted_orphan_users = ROW_COUNT;
  END IF;

  RETURN QUERY VALUES ('candidates_events', v_candidates_events);
  RETURN QUERY VALUES ('deleted_events', v_deleted_events);

  RETURN QUERY VALUES ('candidates_bad_commitments', v_candidates_bad_commitments);
  RETURN QUERY VALUES ('deleted_bad_commitments', v_deleted_bad_commitments);

  RETURN QUERY VALUES ('candidates_orphan_event_items', v_candidates_orphan_items);
  RETURN QUERY VALUES ('deleted_orphan_event_items', v_deleted_orphan_items);

  RETURN QUERY VALUES ('candidates_orphan_event_users', v_candidates_orphan_users);
  RETURN QUERY VALUES ('deleted_orphan_event_users', v_deleted_orphan_users);
END;
$$;

-- Prevent browser clients from calling maintenance directly
REVOKE ALL ON FUNCTION public.potluxy_nightly_maintenance(interval, integer, integer, boolean) FROM PUBLIC;

-- Trigger + maintenance functions are never meant to be called by browsers.
REVOKE ALL ON FUNCTION
  public.potluxy_nightly_maintenance(interval, integer, integer, boolean),
  public.prevent_reduce_below_commitment(),
  public.enforce_commitment_cap(),
  public.lock_event_users_keys(),
  public.enforce_creator_yes()
FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Private schema: identity tables + helpers (not exposed to the API)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.member_credentials (
  member_id       uuid PRIMARY KEY REFERENCES public.event_users(id) ON DELETE CASCADE,
  password_hash   text NOT NULL,
  failed_attempts int  NOT NULL DEFAULT 0,
  locked_until    timestamptz
);

-- One identity per browser (auth uid) per event.
CREATE TABLE IF NOT EXISTS private.member_sessions (
  auth_uid   uuid NOT NULL,
  event_id   uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  member_id  uuid NOT NULL REFERENCES public.event_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (auth_uid, event_id)
);
CREATE INDEX IF NOT EXISTS member_sessions_member_idx ON private.member_sessions (member_id);

CREATE OR REPLACE FUNCTION private.clean(p text, maxlen int, field text, multiline boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE v text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  v := regexp_replace(p, '[\x01-\x09\x0b-\x1f\x7f]', ' ', 'g');
  IF NOT multiline THEN v := regexp_replace(v, '\s+', ' ', 'g'); END IF;
  v := btrim(v);
  IF v = '' THEN RETURN NULL; END IF;
  IF char_length(v) > maxlen THEN
    RAISE EXCEPTION '% is too long (max % characters).', field, maxlen;
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION private.clean_email(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE v text := lower(btrim(COALESCE(p, '')));
BEGIN
  IF v = '' THEN RETURN NULL; END IF;
  IF char_length(v) > 254 OR v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Please enter a valid email address.';
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION private.clean_url(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE v text := btrim(COALESCE(p, ''));
BEGIN
  IF v = '' THEN RETURN NULL; END IF;
  IF char_length(v) > 500 OR v !~* '^https://[^\s<>"''`]+$' THEN
    RAISE EXCEPTION 'The invite link must be a full https:// address.';
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION private.clean_name(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = private, pg_catalog AS $$
DECLARE v text := private.clean(p, 40, 'Name');
BEGIN
  IF v IS NULL OR char_length(v) < 2 THEN
    RAISE EXCEPTION 'Please enter a name (2+ characters).';
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION private.check_new_password(p text)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p IS NOT NULL AND (char_length(p) < 4 OR octet_length(p) > 72) THEN
    RAISE EXCEPTION 'Passwords must be 4 to 72 characters.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION private.uid()
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE v uuid := auth.uid();
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'Your browser session expired. Please refresh the page.';
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION private.event_by_slug(p_slug text, p_for_write boolean DEFAULT false)
RETURNS public.events LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE e public.events;
BEGIN
  SELECT * INTO e FROM public.events WHERE slug = p_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found. Double-check the link.';
  END IF;
  IF p_for_write AND e.delete_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'This event is scheduled for deletion, so it can''t be changed.';
  END IF;
  RETURN e;
END $$;

CREATE OR REPLACE FUNCTION private.my_member(p_event_id uuid)
RETURNS public.event_users LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT eu.*
  FROM private.member_sessions s
  JOIN public.event_users eu ON eu.id = s.member_id
  WHERE s.auth_uid = auth.uid() AND s.event_id = p_event_id
$$;

CREATE OR REPLACE FUNCTION private.link_session(p_event_id uuid, p_member_id uuid)
RETURNS void LANGUAGE sql SET search_path = pg_catalog AS $$
  INSERT INTO private.member_sessions (auth_uid, event_id, member_id)
  VALUES (auth.uid(), p_event_id, p_member_id)
  ON CONFLICT (auth_uid, event_id)
  DO UPDATE SET member_id = EXCLUDED.member_id, created_at = now();
$$;

-- Returns NULL when no password is set. Never raises on a wrong password,
-- so the failed-attempt counter is committed (callers return {error} instead).
CREATE OR REPLACE FUNCTION private.check_password(p_member_id uuid, p_password text)
RETURNS boolean LANGUAGE plpgsql SET search_path = extensions, pg_catalog AS $$
DECLARE c private.member_credentials;
BEGIN
  SELECT * INTO c FROM private.member_credentials WHERE member_id = p_member_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF c.locked_until IS NOT NULL AND c.locked_until > now() THEN
    RETURN false;
  END IF;

  IF p_password IS NOT NULL AND crypt(p_password, c.password_hash) = c.password_hash THEN
    UPDATE private.member_credentials
       SET failed_attempts = 0, locked_until = NULL
     WHERE member_id = p_member_id;
    RETURN true;
  END IF;

  UPDATE private.member_credentials
     SET failed_attempts = CASE WHEN c.failed_attempts + 1 >= 5 THEN 0 ELSE c.failed_attempts + 1 END,
         locked_until    = CASE WHEN c.failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' END
   WHERE member_id = p_member_id;
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION private.is_locked(p_member_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.member_credentials
    WHERE member_id = p_member_id AND locked_until > now()
  )
$$;

CREATE OR REPLACE FUNCTION private.set_password(p_member_id uuid, p_password text)
RETURNS void LANGUAGE plpgsql SET search_path = extensions, pg_catalog AS $$
BEGIN
  PERFORM private.check_new_password(p_password);
  INSERT INTO private.member_credentials (member_id, password_hash)
  VALUES (p_member_id, crypt(p_password, gen_salt('bf', 10)))
  ON CONFLICT (member_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash, failed_attempts = 0, locked_until = NULL;
END $$;

CREATE OR REPLACE FUNCTION private.set_email(p_member_id uuid, p_event_id uuid, p_email text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF p_email IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.event_users
    WHERE event_id = p_event_id AND real_email = p_email AND id <> p_member_id
  ) THEN
    RAISE EXCEPTION 'Another guest at this event already used that email.';
  END IF;
  UPDATE public.event_users SET real_email = p_email WHERE id = p_member_id;
END $$;

CREATE OR REPLACE FUNCTION private.apply_rsvp(m public.event_users, e public.events, p_status text, p_message text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF p_status NOT IN ('yes', 'no') THEN
    RAISE EXCEPTION 'RSVP must be yes or no.';
  END IF;
  IF p_status = 'no' THEN
    IF m.username = e.created_by THEN
      RAISE EXCEPTION 'As the host, you''re always marked as going.';
    END IF;
    DELETE FROM public.commitments WHERE user_id = m.id;
    UPDATE public.event_users
       SET rsvp_status = 'no', wants_reminders = false,
           decline_message = private.clean(p_message, 280, 'Message', true),
           decline_at = now()
     WHERE id = m.id;
  ELSE
    UPDATE public.event_users
       SET rsvp_status = 'yes', wants_reminders = true,
           decline_message = NULL, decline_at = NULL
     WHERE id = m.id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION private.require_host(p_slug text, p_for_write boolean DEFAULT true)
RETURNS public.events LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE e public.events; m public.event_users;
BEGIN
  e := private.event_by_slug(p_slug, p_for_write);
  m := private.my_member(e.id);
  IF m.id IS NULL OR m.username IS DISTINCT FROM e.created_by THEN
    RAISE EXCEPTION 'Only the host can do that.';
  END IF;
  RETURN e;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public API (the only things the browser can call)
-- ---------------------------------------------------------------------------

-- Full view of one event, shaped for the caller (host sees emails + messages).
CREATE OR REPLACE FUNCTION public.get_event(p_slug text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  e public.events;
  m public.event_users;
  v_is_host boolean;
  result jsonb;
BEGIN
  e := private.event_by_slug(p_slug);
  m := private.my_member(e.id);
  v_is_host := m.id IS NOT NULL AND m.username = e.created_by;

  result := jsonb_build_object(
    'event', jsonb_build_object(
      'name', e.event_name,
      'slug', e.slug,
      'description', e.event_description,
      'date', e.event_date,
      'time', left(e.event_time::text, 5),
      'location', e.event_location,
      'lat', e.event_lat,
      'lng', e.event_lng,
      'collect_emails', e.collect_real_emails,
      'invite_url', e.invite_url,
      'schedule_url', e.schedule_url,
      'host', e.created_by,
      'deleting', e.delete_requested_at IS NOT NULL
    ),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id,
        'name', i.item_name,
        'needed', i.quantity_required,
        'description', i.item_description,
        'committed', COALESCE((SELECT sum(c.quantity) FROM commitments c WHERE c.item_id = i.id), 0),
        'mine', COALESCE((SELECT c.quantity FROM commitments c WHERE c.item_id = i.id AND c.user_id = m.id), 0),
        'who', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('name', u.username, 'qty', c.quantity) ORDER BY lower(u.username))
          FROM commitments c JOIN event_users u ON u.id = c.user_id
          WHERE c.item_id = i.id
        ), '[]'::jsonb)
      ) ORDER BY i.created_at, lower(i.item_name))
      FROM event_items i WHERE i.event_id = e.id
    ), '[]'::jsonb),
    'going', COALESCE((
      SELECT jsonb_agg(u.username ORDER BY u.username = e.created_by DESC, lower(u.username))
      FROM event_users u WHERE u.event_id = e.id AND u.rsvp_status = 'yes'
    ), '[]'::jsonb),
    'not_going_count', (
      SELECT count(*) FROM event_users u WHERE u.event_id = e.id AND u.rsvp_status = 'no'
    ),
    'me', CASE WHEN m.id IS NULL THEN NULL ELSE jsonb_build_object(
      'name', m.username,
      'rsvp', m.rsvp_status,
      'email', m.real_email,
      'is_host', v_is_host,
      'has_password', EXISTS (SELECT 1 FROM private.member_credentials WHERE member_id = m.id)
    ) END
  );

  IF v_is_host THEN
    result := result || jsonb_build_object('guests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', u.username,
        'rsvp', u.rsvp_status,
        'email', u.real_email,
        'message', u.decline_message,
        'responded_at', COALESCE(u.decline_at, u.created_at)
      ) ORDER BY u.rsvp_status DESC, lower(u.username))
      FROM event_users u WHERE u.event_id = e.id
    ), '[]'::jsonb));
  END IF;

  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.create_event(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_uid uuid := private.uid();
  v_name text := private.clean(p->>'name', 120, 'Event name');
  v_host text := private.clean_name(p->>'host_name');
  v_pwd text := NULLIF(p->>'password', '');
  v_email text := private.clean_email(p->>'email');
  v_lat double precision := NULLIF(p->>'lat', '')::double precision;
  v_lng double precision := NULLIF(p->>'lng', '')::double precision;
  v_slug text;
  v_event_id uuid;
  v_member_id uuid := gen_random_uuid();
  v_recent int;
BEGIN
  IF v_name IS NULL THEN RAISE EXCEPTION 'Please give your event a name.'; END IF;
  PERFORM private.check_new_password(v_pwd);
  IF v_lat NOT BETWEEN -90 AND 90 OR v_lng NOT BETWEEN -180 AND 180 THEN
    v_lat := NULL; v_lng := NULL;
  END IF;

  SELECT count(*) INTO v_recent
  FROM private.member_sessions s
  JOIN public.events e ON e.id = s.event_id
  JOIN public.event_users u ON u.id = s.member_id
  WHERE s.auth_uid = v_uid AND u.username = e.created_by
    AND e.created_at > now() - interval '1 day';
  IF v_recent >= 20 THEN
    RAISE EXCEPTION 'You''ve created a lot of events today. Please try again tomorrow.';
  END IF;

  v_slug := btrim(left(lower(regexp_replace(v_name, '[^a-zA-Z0-9]+', '-', 'g')), 40), '-');
  v_slug := CASE WHEN v_slug = '' THEN 'event' ELSE v_slug END
            || '-' || encode(gen_random_bytes(6), 'hex');

  INSERT INTO public.events (
    event_name, slug, created_by, event_description, event_date, event_time,
    event_location, event_place_id, event_lat, event_lng, collect_real_emails, invite_url,
    schedule_url
  ) VALUES (
    v_name, v_slug, v_host,
    private.clean(p->>'description', 2000, 'Description', true),
    NULLIF(p->>'date', '')::date,
    NULLIF(p->>'time', '')::time,
    private.clean(p->>'location', 300, 'Location'),
    private.clean(p->>'place_id', 100, 'Place id'),
    v_lat, v_lng,
    COALESCE((p->>'collect_emails')::boolean, false),
    private.clean_url(p->>'invite_url'),
    private.clean_url(p->>'schedule_url')
  ) RETURNING id INTO v_event_id;

  INSERT INTO public.event_users (id, event_id, username, rsvp_status, wants_reminders, real_email)
  VALUES (v_member_id, v_event_id, v_host, 'yes', true, v_email);

  PERFORM private.link_session(v_event_id, v_member_id);
  IF v_pwd IS NOT NULL THEN
    PERFORM private.set_password(v_member_id, v_pwd);
  END IF;

  RETURN jsonb_build_object('slug', v_slug);
END $$;

-- RSVP as a new guest, or re-join under your own name (needs its password
-- unless this browser is already linked to it).
CREATE OR REPLACE FUNCTION public.join_event(p_slug text, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := private.uid();
  e public.events := private.event_by_slug(p_slug, true);
  v_name text := private.clean_name(p->>'name');
  v_pwd text := NULLIF(p->>'password', '');
  v_email text := private.clean_email(p->>'email');
  v_rsvp text := COALESCE(NULLIF(p->>'rsvp', ''), 'yes');
  u public.event_users;
  v_ok boolean;
BEGIN
  SELECT * INTO u FROM public.event_users
  WHERE event_id = e.id AND lower(username) = lower(v_name);

  IF FOUND THEN
    IF NOT EXISTS (
      SELECT 1 FROM private.member_sessions
      WHERE auth_uid = v_uid AND event_id = e.id AND member_id = u.id
    ) THEN
      v_ok := private.check_password(u.id, v_pwd);
      IF v_ok IS NULL THEN
        RETURN jsonb_build_object('error', format(
          'Someone already responded as "%s" without a password, so only their original browser can change it. If that''s not you, add an initial or nickname.',
          u.username));
      ELSIF NOT v_ok THEN
        IF private.is_locked(u.id) THEN
          RETURN jsonb_build_object('error', 'Too many wrong passwords. Try again in 15 minutes.');
        END IF;
        RETURN jsonb_build_object('error', format(
          'The name "%s" is taken and that password didn''t match.', u.username));
      END IF;
      PERFORM private.link_session(e.id, u.id);
    END IF;
  ELSE
    IF v_rsvp = 'yes' AND e.collect_real_emails AND v_email IS NULL THEN
      RAISE EXCEPTION 'The host asked for an email so they can send reminders.';
    END IF;
    PERFORM private.check_new_password(v_pwd);
    INSERT INTO public.event_users (id, event_id, username, rsvp_status, wants_reminders)
    VALUES (gen_random_uuid(), e.id, v_name, 'yes', true)
    RETURNING * INTO u;
    PERFORM private.link_session(e.id, u.id);
    IF v_pwd IS NOT NULL THEN
      PERFORM private.set_password(u.id, v_pwd);
    END IF;
  END IF;

  IF v_email IS NOT NULL AND v_email IS DISTINCT FROM u.real_email THEN
    PERFORM private.set_email(u.id, e.id, v_email);
  END IF;
  SELECT * INTO u FROM public.event_users WHERE id = u.id;
  PERFORM private.apply_rsvp(u, e, v_rsvp, p->>'message');

  RETURN public.get_event(p_slug);
END $$;

-- "I already responded": sign in from another browser with name (or email) + password.
CREATE OR REPLACE FUNCTION public.sign_in(p_slug text, p_ident text, p_password text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := private.uid();
  e public.events := private.event_by_slug(p_slug);
  v_ident text := btrim(COALESCE(p_ident, ''));
  v_by_email boolean := position('@' in v_ident) > 0;
  u public.event_users;
  v_ok boolean;
  v_generic text := 'That name/email and password don''t match.';
BEGIN
  IF v_by_email THEN
    SELECT * INTO u FROM public.event_users WHERE event_id = e.id AND real_email = lower(v_ident);
  ELSE
    SELECT * INTO u FROM public.event_users
    WHERE event_id = e.id AND lower(username) = lower(regexp_replace(v_ident, '\s+', ' ', 'g'));
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', v_generic);
  END IF;

  v_ok := private.check_password(u.id, p_password);
  IF v_ok IS NULL THEN
    IF v_by_email THEN RETURN jsonb_build_object('error', v_generic); END IF;
    RETURN jsonb_build_object('error', format(
      '"%s" didn''t set a password, so that response can only be changed from the browser it was made in.',
      u.username));
  ELSIF NOT v_ok THEN
    IF private.is_locked(u.id) THEN
      RETURN jsonb_build_object('error', 'Too many wrong passwords. Try again in 15 minutes.');
    END IF;
    RETURN jsonb_build_object('error', v_generic);
  END IF;

  PERFORM private.link_session(e.id, u.id);
  RETURN public.get_event(p_slug);
END $$;

CREATE OR REPLACE FUNCTION public.sign_out(p_slug text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE e public.events := private.event_by_slug(p_slug);
BEGIN
  DELETE FROM private.member_sessions WHERE auth_uid = private.uid() AND event_id = e.id;
  RETURN public.get_event(p_slug);
END $$;

-- Change my RSVP / email / password. Keys are optional:
--   rsvp, message, email, password, current_password
CREATE OR REPLACE FUNCTION public.update_me(p_slug text, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  e public.events := private.event_by_slug(p_slug, true);
  m public.event_users := private.my_member(e.id);
  v_ok boolean;
BEGIN
  IF m.id IS NULL THEN RAISE EXCEPTION 'Add your name to this event first.'; END IF;

  IF p ? 'email' THEN
    PERFORM private.set_email(m.id, e.id, private.clean_email(p->>'email'));
  END IF;

  IF NULLIF(p->>'password', '') IS NOT NULL THEN
    v_ok := private.check_password(m.id, p->>'current_password');
    IF v_ok = false THEN
      RETURN jsonb_build_object('error', 'Your current password is incorrect.');
    END IF;
    PERFORM private.set_password(m.id, p->>'password');
  END IF;

  IF p ? 'rsvp' THEN
    SELECT * INTO m FROM public.event_users WHERE id = m.id;
    PERFORM private.apply_rsvp(m, e, p->>'rsvp', p->>'message');
  END IF;

  RETURN public.get_event(p_slug);
END $$;

-- Set how many of an item I'm bringing (0 removes my commitment).
CREATE OR REPLACE FUNCTION public.set_commitment(p_item_id uuid, p_qty int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  i public.event_items;
  e public.events;
  m public.event_users;
  v_others int;
BEGIN
  PERFORM private.uid();
  SELECT * INTO i FROM public.event_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That item no longer exists.'; END IF;
  SELECT * INTO e FROM public.events WHERE id = i.event_id;
  IF e.delete_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'This event is scheduled for deletion, so it can''t be changed.';
  END IF;
  m := private.my_member(e.id);
  IF m.id IS NULL THEN RAISE EXCEPTION 'Add your name to this event first.'; END IF;
  IF p_qty IS NULL OR p_qty < 0 OR p_qty > 999 THEN
    RAISE EXCEPTION 'Enter a number from 0 to 999.';
  END IF;

  IF p_qty = 0 THEN
    DELETE FROM public.commitments WHERE item_id = i.id AND user_id = m.id;
  ELSE
    IF m.rsvp_status <> 'yes' THEN
      PERFORM private.apply_rsvp(m, e, 'yes', NULL);
    END IF;
    SELECT COALESCE(sum(quantity), 0) INTO v_others
    FROM public.commitments WHERE item_id = i.id AND user_id IS DISTINCT FROM m.id;
    IF v_others + p_qty > i.quantity_required THEN
      RAISE EXCEPTION 'Only % more "%" needed.', GREATEST(i.quantity_required - v_others, 0), i.item_name;
    END IF;
    INSERT INTO public.commitments (event_id, user_id, item_id, quantity)
    VALUES (e.id, m.id, i.id, p_qty)
    ON CONFLICT (event_id, user_id, item_id) DO UPDATE SET quantity = EXCLUDED.quantity;
  END IF;

  RETURN public.get_event(e.slug);
END $$;

-- ---- Host-only ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.host_update_event(p_slug text, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  e public.events := private.require_host(p_slug);
  v_name text := private.clean(p->>'name', 120, 'Event name');
  v_lat double precision := NULLIF(p->>'lat', '')::double precision;
  v_lng double precision := NULLIF(p->>'lng', '')::double precision;
BEGIN
  IF v_name IS NULL THEN RAISE EXCEPTION 'Please give your event a name.'; END IF;
  IF v_lat NOT BETWEEN -90 AND 90 OR v_lng NOT BETWEEN -180 AND 180 THEN
    v_lat := NULL; v_lng := NULL;
  END IF;
  UPDATE public.events SET
    event_name          = v_name,
    event_description   = private.clean(p->>'description', 2000, 'Description', true),
    event_date          = NULLIF(p->>'date', '')::date,
    event_time          = NULLIF(p->>'time', '')::time,
    event_location      = private.clean(p->>'location', 300, 'Location'),
    event_place_id      = private.clean(p->>'place_id', 100, 'Place id'),
    event_lat           = v_lat,
    event_lng           = v_lng,
    collect_real_emails = COALESCE((p->>'collect_emails')::boolean, false),
    invite_url          = private.clean_url(p->>'invite_url'),
    schedule_url        = private.clean_url(p->>'schedule_url')
  WHERE id = e.id;
  RETURN public.get_event(p_slug);
END $$;

-- p_item_id NULL = add a new item.
CREATE OR REPLACE FUNCTION public.host_save_item(p_slug text, p_item_id uuid, p_name text, p_needed int, p_description text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  e public.events := private.require_host(p_slug);
  v_name text := private.clean(p_name, 120, 'Item name');
  v_desc text := private.clean(p_description, 300, 'Item note');
BEGIN
  IF v_name IS NULL THEN RAISE EXCEPTION 'Please name the item.'; END IF;
  IF p_needed IS NULL OR p_needed < 1 OR p_needed > 999 THEN
    RAISE EXCEPTION 'Quantity must be 1 to 999.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.event_items
    WHERE event_id = e.id AND lower(item_name) = lower(v_name)
      AND id IS DISTINCT FROM p_item_id
  ) THEN
    RAISE EXCEPTION 'You already have an item called "%".', v_name;
  END IF;

  IF p_item_id IS NULL THEN
    IF (SELECT count(*) FROM public.event_items WHERE event_id = e.id) >= 200 THEN
      RAISE EXCEPTION 'Events can have up to 200 items.';
    END IF;
    INSERT INTO public.event_items (event_id, item_name, quantity_required, item_description)
    VALUES (e.id, v_name, p_needed, v_desc);
  ELSE
    UPDATE public.event_items
       SET item_name = v_name, quantity_required = p_needed, item_description = v_desc
     WHERE id = p_item_id AND event_id = e.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'That item no longer exists.'; END IF;
  END IF;

  RETURN public.get_event(p_slug);
END $$;

CREATE OR REPLACE FUNCTION public.host_delete_item(p_slug text, p_item_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE e public.events := private.require_host(p_slug);
BEGIN
  DELETE FROM public.event_items WHERE id = p_item_id AND event_id = e.id;
  RETURN public.get_event(p_slug);
END $$;

-- p_items: [{"name": "...", "needed": 2, "description": "..."}]; matches existing items by name.
CREATE OR REPLACE FUNCTION public.host_import_items(p_slug text, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  e public.events := private.require_host(p_slug);
  r jsonb;
  v_name text;
  v_needed int;
  v_existing uuid;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'Import up to 200 items at a time.';
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_name := private.clean(r->>'name', 120, 'Item name');
    CONTINUE WHEN v_name IS NULL;
    v_needed := LEAST(GREATEST(COALESCE(NULLIF(r->>'needed', '')::int, 1), 1), 999);
    SELECT id INTO v_existing FROM public.event_items
    WHERE event_id = e.id AND lower(item_name) = lower(v_name);
    PERFORM public.host_save_item(p_slug, v_existing, v_name, v_needed, r->>'description');
  END LOOP;
  RETURN public.get_event(p_slug);
END $$;

CREATE OR REPLACE FUNCTION public.host_remove_guest(p_slug text, p_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  e public.events := private.require_host(p_slug);
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.event_users
  WHERE event_id = e.id AND lower(username) = lower(p_name) AND username <> e.created_by;
  IF v_id IS NULL THEN RAISE EXCEPTION 'Guest not found.'; END IF;
  DELETE FROM public.commitments WHERE user_id = v_id;
  DELETE FROM public.event_users WHERE id = v_id;
  RETURN public.get_event(p_slug);
END $$;

CREATE OR REPLACE FUNCTION public.host_set_deleted(p_slug text, p_deleted boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE e public.events := private.require_host(p_slug, false);
BEGIN
  UPDATE public.events
     SET delete_requested_at = CASE WHEN p_deleted THEN now() END
   WHERE id = e.id;
  RETURN public.get_event(p_slug);
END $$;

-- ---------------------------------------------------------------------------
-- Grants: browsers may call the API functions and nothing else.
-- (Supabase grants EXECUTE on new public functions to anon by default.)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.get_event(text),
  public.create_event(jsonb),
  public.join_event(text, jsonb),
  public.sign_in(text, text, text),
  public.sign_out(text),
  public.update_me(text, jsonb),
  public.set_commitment(uuid, int),
  public.host_update_event(text, jsonb),
  public.host_save_item(text, uuid, text, int, text),
  public.host_delete_item(text, uuid),
  public.host_import_items(text, jsonb),
  public.host_remove_guest(text, text),
  public.host_set_deleted(text, boolean)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_event(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.create_event(jsonb),
  public.join_event(text, jsonb),
  public.sign_in(text, text, text),
  public.sign_out(text),
  public.update_me(text, jsonb),
  public.set_commitment(uuid, int),
  public.host_update_event(text, jsonb),
  public.host_save_item(text, uuid, text, int, text),
  public.host_delete_item(text, uuid),
  public.host_import_items(text, jsonb),
  public.host_remove_guest(text, text),
  public.host_set_deleted(text, boolean)
TO authenticated;


NOTIFY pgrst, 'reload schema';

-- (Optional) nightly purge via pg_cron (run separately; see code/delete_events_schedule.sql):
--   select cron.schedule(
--     'potluxy-nightly-maintenance',
--     '15 4 * * *',
--     $$ select * from public.potluxy_nightly_maintenance(interval '7 days', 250, 5000, false); $$
--   );
