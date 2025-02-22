-- (Optional) Enable pgcrypto extension if not already enabled (for gen_random_uuid)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

---------------------------
-- 1. EVENTS TABLE
---------------------------
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL, -- friendly URL slug (generate using event_name + unique identifier)
    created_by TEXT NOT NULL,  -- Username of the event creator
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

---------------------------
-- 2. EVENT ITEMS TABLE
---------------------------
CREATE TABLE event_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    item_name TEXT NOT NULL,
    quantity_required INT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(event_id, item_name)
);

---------------------------
-- 3. USERS TABLE (Per Event)
---------------------------
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    password_hash TEXT,  -- Store hashed password; can be NULL if no password provided
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(event_id, username)
);

---------------------------
-- 4. COMMITMENTS TABLE (User Commitments)
---------------------------
CREATE TABLE commitments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    item_id UUID NOT NULL REFERENCES event_items(id) ON DELETE CASCADE,
    quantity INT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(event_id, user_id, item_id)
);

---------------------------
-- Enable Row Level Security (RLS)
---------------------------
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE commitments ENABLE ROW LEVEL SECURITY;

---------------------------
-- RLS Policies
---------------------------

-- EVENTS: Allow anyone to SELECT events (public view)
CREATE POLICY "Public select on events"
ON events FOR SELECT
USING (true);

-- Allow anyone to INSERT new events without authentication
CREATE POLICY "Public insert on events"
ON events FOR INSERT
WITH CHECK (true);

-- Allow only the creator to UPDATE or DELETE their own event
CREATE POLICY "Event creator can modify own events"
ON events FOR UPDATE
USING (
  created_by = current_setting('request.jwt.claims', true)::jsonb->>'username'
);

CREATE POLICY "Event creator can delete own events"
ON events FOR DELETE
USING (
  created_by = current_setting('request.jwt.claims', true)::jsonb->>'username'
);

-- EVENT ITEMS: Only the event creator can add/modify items
CREATE POLICY "Event items select"
ON event_items FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM events
    WHERE events.id = event_items.event_id
  )
);

CREATE POLICY "Event items insert"
ON event_items FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM events
    WHERE events.id = event_items.event_id
  )
);

CREATE POLICY "Event items update"
ON event_items FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM events
    WHERE events.id = event_items.event_id
    AND events.created_by = current_setting('request.jwt.claims', true)::jsonb->>'username'
  )
);

CREATE POLICY "Event items delete"
ON event_items FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM events
    WHERE events.id = event_items.event_id
    AND events.created_by = current_setting('request.jwt.claims', true)::jsonb->>'username'
  )
);

-- USERS: Allow users to sign up and see their own user records
CREATE POLICY "Users select"
ON users FOR SELECT
USING (true);

CREATE POLICY "Users insert"
ON users FOR INSERT
WITH CHECK (true);

-- COMMITMENTS: Users can only see and edit their own commitments
CREATE POLICY "Commitments select"
ON commitments FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.id = commitments.user_id
  )
);

CREATE POLICY "Commitments insert"
ON commitments FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.id = commitments.user_id
  )
);

CREATE POLICY "Commitments update"
ON commitments FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.id = commitments.user_id
  )
);

CREATE POLICY "Commitments delete"
ON commitments FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.id = commitments.user_id
  )
);
