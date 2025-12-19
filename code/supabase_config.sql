-- ============================================
-- Potluxy schema (fresh install + migration-safe tail)
-- YES/NO only; creator always 'yes'; no new tables
-- ============================================

-- 0) Extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

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

  -- deletion flags used by UI
  delete_requested_at TIMESTAMPTZ,
  marked_for_deletion BOOLEAN NOT NULL DEFAULT false
);

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
  id UUID PRIMARY KEY, -- normally auth.uid() (username-only RSVP No may mint a random UUID client-side)
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- attendee's real email for THIS event
  real_email TEXT,

  -- reminders opt-out
  wants_reminders BOOLEAN NOT NULL DEFAULT true,

  -- RSVP (+ decline fields)
  rsvp_status TEXT NOT NULL DEFAULT 'yes' CHECK (rsvp_status IN ('yes','no')),
  decline_message TEXT,
  decline_at TIMESTAMPTZ,

  UNIQUE(event_id, username)
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

-- ✅ Convenience indices
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
-- Enable Row Level Security
-- --------------------------------------------
ALTER TABLE public.events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_users  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commitments  ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------
-- RLS Policies
-- --------------------------------------------

-- EVENTS: public read + anyone can insert (host creates)
CREATE POLICY IF NOT EXISTS "Public select on events"
  ON public.events FOR SELECT USING (true);

CREATE POLICY IF NOT EXISTS "Public insert on events"
  ON public.events FOR INSERT WITH CHECK (true);

-- Only creator can UPDATE/DELETE the event
CREATE POLICY IF NOT EXISTS "Event update"
  ON public.events FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.event_users
      WHERE event_users.id = auth.uid()
        AND event_users.event_id = events.id
        AND event_users.username = events.created_by
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.event_users
      WHERE event_users.id = auth.uid()
        AND event_users.event_id = events.id
        AND event_users.username = events.created_by
    )
  );

CREATE POLICY IF NOT EXISTS "Event delete"
  ON public.events FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.event_users
      WHERE event_users.id = auth.uid()
        AND event_users.event_id = events.id
        AND event_users.username = events.created_by
    )
  );

-- EVENT ITEMS: public read; creator CRUD
CREATE POLICY IF NOT EXISTS "Event items select"
  ON public.event_items FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.events WHERE events.id = event_items.event_id)
  );

CREATE POLICY IF NOT EXISTS "Event items insert"
  ON public.event_items FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.event_users
      WHERE event_users.id = auth.uid()
        AND event_users.event_id = event_items.event_id
        AND event_users.username = (
          SELECT created_by FROM public.events WHERE events.id = event_items.event_id
        )
    )
  );

CREATE POLICY IF NOT EXISTS "Event items update"
  ON public.event_items FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.event_users
      WHERE event_users.id = auth.uid()
        AND event_users.event_id = event_items.event_id
        AND event_users.username = (
          SELECT created_by FROM public.events WHERE events.id = event_items.event_id
        )
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.event_users
      WHERE event_users.id = auth.uid()
        AND event_users.event_id = event_items.event_id
        AND event_users.username = (
          SELECT created_by FROM public.events WHERE events.id = event_items.event_id
        )
    )
  );

CREATE POLICY IF NOT EXISTS "Event items delete"
  ON public.event_items FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.event_users
      WHERE event_users.id = auth.uid()
        AND event_users.event_id = event_items.event_id
        AND event_users.username = (
          SELECT created_by FROM public.events WHERE events.id = event_items.event_id
        )
    )
  );

-- EVENT_USERS:
-- Keep public SELECT so email->username lookup works pre-auth (also avoids policy recursion)
CREATE POLICY IF NOT EXISTS "Event users select"
  ON public.event_users FOR SELECT USING (true);

-- Normal attendee creation requires auth.uid() (logged-in path)
CREATE POLICY IF NOT EXISTS "Event users insert"
  ON public.event_users FOR INSERT
  WITH CHECK (id = auth.uid());

-- Attendees can update their own row (email/opt-out/status, etc.)
CREATE POLICY IF NOT EXISTS "Event users update self"
  ON public.event_users FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- MVP public decline (username-only "RSVP No" without auth)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='event_users' AND policyname='eu_insert_no'
  ) THEN
    CREATE POLICY eu_insert_no ON public.event_users
      FOR INSERT
      WITH CHECK (rsvp_status = 'no' AND wants_reminders IS NOT TRUE);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='event_users' AND policyname='eu_upsert_no'
  ) THEN
    CREATE POLICY eu_upsert_no ON public.event_users
      FOR UPDATE
      USING (true)
      WITH CHECK (rsvp_status = 'no' AND wants_reminders IS NOT TRUE);
  END IF;
END$$;

-- COMMITMENTS: each user manages their own
CREATE POLICY IF NOT EXISTS "Commitments select"
  ON public.commitments FOR SELECT USING (true);

CREATE POLICY IF NOT EXISTS "Commitments insert"
  ON public.commitments FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "Commitments update"
  ON public.commitments FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "Commitments delete"
  ON public.commitments FOR DELETE USING (user_id = auth.uid());

-- --------------------------------------------
-- Additional rules / protections
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

-- Disallow moving an event_user to another event or renaming their identity
CREATE OR REPLACE FUNCTION public.lock_event_users_keys()
RETURNS trigger AS $f$
DECLARE original_row public.event_users;
BEGIN
  SELECT * INTO original_row FROM public.event_users WHERE id = NEW.id;
  IF original_row IS NOT NULL THEN
    IF NEW.event_id IS DISTINCT FROM original_row.event_id THEN
      RAISE EXCEPTION 'You cannot change event_id on event_users';
    END IF;
    IF NEW.username IS DISTINCT FROM original_row.username THEN
      RAISE EXCEPTION 'You cannot change username on event_users';
    END IF;
  END IF;
  RETURN NEW;
END;
$f$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS lock_event_users_keys ON public.event_users;
CREATE TRIGGER lock_event_users_keys
BEFORE UPDATE ON public.event_users
FOR EACH ROW
EXECUTE FUNCTION public.lock_event_users_keys();

-- Force creators to remain RSVP 'yes' (cannot flip to 'no')
CREATE OR REPLACE FUNCTION public.enforce_creator_yes()
RETURNS trigger AS $
$DECLARE is_creator BOOLEAN;
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
$ $ LANGUAGE plpgsql;

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
-- NEW: Flip a username to RSVP 'yes' for this event, claim row
--      for auth.uid() (used by the “RSVP Yes” form re-using name)
-- ============================================================
CREATE OR REPLACE FUNCTION public.rsvp_yes_claim(
  p_event_id uuid,
  p_username text,
  p_real_email text DEFAULT NULL
)
RETURNS public.event_users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.event_users;
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth.uid() is null';
  END IF;

  -- First try to take over an existing row for this username (case-insensitive)
  UPDATE public.event_users eu
     SET id              = v_uid,
         rsvp_status     = 'yes',
         wants_reminders = true,
         decline_message = NULL,
         decline_at      = NULL,
         real_email      = COALESCE(p_real_email, eu.real_email)
   WHERE eu.event_id = p_event_id
     AND lower(eu.username) = lower(p_username)
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- Otherwise insert fresh; if exact-case username exists, update it to 'yes'
    INSERT INTO public.event_users (id, event_id, username, rsvp_status, wants_reminders, real_email)
    VALUES (v_uid, p_event_id, p_username, 'yes', true, p_real_email)
    ON CONFLICT (event_id, username) DO UPDATE
      SET id              = EXCLUDED.id,
          rsvp_status     = 'yes',
          wants_reminders = true,
          decline_message = NULL,
          decline_at      = NULL,
          real_email      = COALESCE(EXCLUDED.real_email, public.event_users.real_email)
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.rsvp_yes_claim(uuid, text, text) TO anon, authenticated;

-- ============================================
-- Migration-safe addendum (safe to re-run)
-- ============================================

-- Ensure events deletion flags exist (for older DBs)
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS delete_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS marked_for_deletion BOOLEAN NOT NULL DEFAULT false;

-- Ensure decline columns & RSVP column exist
ALTER TABLE public.event_users
  ADD COLUMN IF NOT EXISTS decline_message TEXT,
  ADD COLUMN IF NOT EXISTS decline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rsvp_status TEXT;

-- Normalize the RSVP check to YES/NO only (no maybe anywhere)
DO $$
DECLARE conname text;
BEGIN
  SELECT c.conname INTO conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname='public' AND t.relname='event_users'
    AND c.contype='c' AND pg_get_constraintdef(c.oid) ILIKE '%rsvp_status%';

  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.event_users DROP CONSTRAINT %I', conname);
  END IF;

  ALTER TABLE public.event_users
    ADD CONSTRAINT event_users_rsvp_status_chk
    CHECK (rsvp_status IN ('yes','no'));
END$$;

-- Default + backfill
ALTER TABLE public.event_users
  ALTER COLUMN rsvp_status SET DEFAULT 'yes';

-- If any legacy values exist, coerce them safely
UPDATE public.event_users
SET rsvp_status = 'no'
WHERE rsvp_status IS NOT NULL AND rsvp_status NOT IN ('yes','no');
