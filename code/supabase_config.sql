-- Enable pgcrypto for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

---------------------------
-- 1. EVENTS TABLE
---------------------------
CREATE TABLE public.events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    event_description TEXT,
    event_date DATE,
    event_time TIME,

    -- optional location fields
    event_location TEXT,
    event_place_id TEXT,
    event_lat DOUBLE PRECISION,
    event_lng DOUBLE PRECISION,

    -- NEW: whether the host wants to collect real emails
    collect_real_emails BOOLEAN NOT NULL DEFAULT false
);

---------------------------
-- 2. EVENT ITEMS TABLE
---------------------------
CREATE TABLE public.event_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    item_name TEXT NOT NULL,
    quantity_required INT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    item_description TEXT,
    UNIQUE(event_id, item_name)
);

---------------------------
-- 3. EVENT_USERS TABLE (Event-Specific Profiles)
---------------------------
CREATE TABLE public.event_users (
    id UUID PRIMARY KEY, -- this is auth.uid()
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,

    -- NEW: attendee's real email for THIS event
    real_email TEXT,

    UNIQUE(event_id, username)
);

-- keep emails unique PER event (NULLs allowed)
CREATE UNIQUE INDEX IF NOT EXISTS event_users_event_id_real_email_idx
ON public.event_users (event_id, real_email)
WHERE real_email IS NOT NULL;

---------------------------
-- 4. COMMITMENTS TABLE (User Commitments)
---------------------------
CREATE TABLE public.commitments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.event_users(id) ON DELETE SET NULL,
    item_id UUID NOT NULL REFERENCES public.event_items(id) ON DELETE CASCADE,
    quantity INT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(event_id, user_id, item_id)
);

---------------------------
-- Enable Row Level Security (RLS)
---------------------------
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commitments ENABLE ROW LEVEL SECURITY;

---------------------------
-- RLS Policies
---------------------------

-- EVENTS: Public SELECT and INSERT are allowed.
CREATE POLICY "Public select on events" ON public.events
FOR SELECT
USING (true);

CREATE POLICY "Public insert on events" ON public.events
FOR INSERT
WITH CHECK (true);

-- Only allow UPDATE/DELETE if the current auth user is the creator.
CREATE POLICY "Event update" ON public.events
FOR UPDATE
USING (
    EXISTS (
        SELECT 1
        FROM public.event_users
        WHERE event_users.id = auth.uid()
          AND event_users.event_id = events.id
          AND event_users.username = events.created_by
    )
);

CREATE POLICY "Event delete" ON public.events
FOR DELETE
USING (
    EXISTS (
        SELECT 1
        FROM public.event_users
        WHERE event_users.id = auth.uid()
          AND event_users.event_id = events.id
          AND event_users.username = events.created_by
    )
);

-- EVENT ITEMS: Public SELECT; creator CRUD
CREATE POLICY "Event items select" ON public.event_items
FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM public.events
        WHERE events.id = event_items.event_id
    )
);

CREATE POLICY "Event items insert" ON public.event_items
FOR INSERT
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.event_users
        WHERE event_users.id = auth.uid()
          AND event_users.event_id = event_items.event_id
          AND event_users.username = (
            SELECT created_by FROM public.events
            WHERE events.id = event_items.event_id
          )
    )
);

CREATE POLICY "Event items update" ON public.event_items
FOR UPDATE
USING (
    EXISTS (
        SELECT 1 FROM public.event_users
        WHERE event_users.id = auth.uid()
          AND event_users.event_id = event_items.event_id
          AND event_users.username = (
            SELECT created_by FROM public.events
            WHERE events.id = event_items.event_id
          )
    )
);

CREATE POLICY "Event items delete" ON public.event_items
FOR DELETE
USING (
    EXISTS (
        SELECT 1 FROM public.event_users
        WHERE event_users.id = auth.uid()
          AND event_users.event_id = event_items.event_id
          AND event_users.username = (
            SELECT created_by FROM public.events
            WHERE events.id = event_items.event_id
          )
    )
);

-- EVENT USERS
CREATE POLICY "Event users select" ON public.event_users
FOR SELECT
USING (true);

CREATE POLICY "Event users insert" ON public.event_users
FOR INSERT
WITH CHECK (id = auth.uid());

-- NEW: let a user update their own event_users row (to add real_email)
CREATE POLICY "Event users update self" ON public.event_users
FOR UPDATE
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- COMMITMENTS
CREATE POLICY "Commitments select" ON public.commitments
FOR SELECT
USING (true);

CREATE POLICY "Commitments insert" ON public.commitments
FOR INSERT
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Commitments update" ON public.commitments
FOR UPDATE
USING (user_id = auth.uid());

CREATE POLICY "Commitments delete" ON public.commitments
FOR DELETE
USING (user_id = auth.uid());

---------------------------
-- Additional Constraints
---------------------------

-- Prevent overcommitments on INSERT
CREATE POLICY "Prevent overcommitments on insert"
ON public.commitments
FOR INSERT
WITH CHECK (
    quantity <= (
        SELECT quantity_required
             - COALESCE((
                 SELECT SUM(quantity)
                 FROM public.commitments
                 WHERE item_id = commitments.item_id
               ), 0)
        FROM public.event_items
        WHERE id = commitments.item_id
    )
);

-- Prevent overcommitments on UPDATE
CREATE POLICY "Prevent overcommitments on update"
ON public.commitments
FOR UPDATE
WITH CHECK (
    quantity <= (
        SELECT quantity_required
             - COALESCE((
                 SELECT SUM(quantity)
                 FROM public.commitments
                 WHERE item_id = commitments.item_id
               ), 0)
        FROM public.event_items
        WHERE id = commitments.item_id
    )
);

-- Prevent reducing quantity below existing commitments
CREATE OR REPLACE FUNCTION public.prevent_reduce_below_commitment()
RETURNS TRIGGER AS $$
DECLARE
    total_committed INT;
BEGIN
    SELECT COALESCE(SUM(quantity), 0)
    INTO total_committed
    FROM public.commitments
    WHERE item_id = NEW.id;

    IF NEW.quantity_required < total_committed THEN
        RAISE EXCEPTION 'Cannot reduce required quantity below existing commitments (%).', total_committed;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_reduce_below_commitment_trigger
BEFORE UPDATE ON public.event_items
FOR EACH ROW
EXECUTE FUNCTION public.prevent_reduce_below_commitment();

-- extra: lock event_users keys (same as in migration)
CREATE OR REPLACE FUNCTION public.lock_event_users_keys()
RETURNS trigger AS $f$
DECLARE
  original_row public.event_users;
BEGIN
  SELECT * INTO original_row
  FROM public.event_users
  WHERE id = NEW.id;

  IF NEW.event_id IS DISTINCT FROM original_row.event_id THEN
    RAISE EXCEPTION 'You cannot change event_id on event_users';
  END IF;

  IF NEW.username IS DISTINCT FROM original_row.username THEN
    RAISE EXCEPTION 'You cannot change username on event_users';
  END IF;

  RETURN NEW;
END;
$f$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER lock_event_users_keys
BEFORE UPDATE ON public.event_users
FOR EACH ROW
EXECUTE FUNCTION public.lock_event_users_keys();
