-- Enable pgcrypto for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

---------------------------
-- 1. EVENTS TABLE
---------------------------
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL, -- friendly URL slug (generated from event_name + unique identifier)
    created_by TEXT NOT NULL,  -- the username (from event_users) of the event creator
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
-- 3. EVENT_USERS TABLE (Event-Specific Profiles)
---------------------------
-- This table links a global auth user (auth.users.uid) with an event.
CREATE TABLE event_users (
    id UUID PRIMARY KEY,  -- This should match the id in auth.users
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(event_id, username)
);

---------------------------
-- 4. COMMITMENTS TABLE (User Commitments)
---------------------------
CREATE TABLE commitments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id UUID REFERENCES event_users(id) ON DELETE SET NULL,
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
ALTER TABLE event_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE commitments ENABLE ROW LEVEL SECURITY;

---------------------------
-- RLS Policies
---------------------------

-- EVENTS: Public SELECT and INSERT are allowed.
CREATE POLICY "Public select on events" ON events FOR SELECT USING (true);
CREATE POLICY "Public insert on events" ON events FOR INSERT WITH CHECK (true);
-- Only allow UPDATE/DELETE if the current auth user is the creator.
CREATE POLICY "Event update" ON events FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM event_users
      WHERE event_users.id = auth.uid()
        AND event_users.event_id = events.id
        AND event_users.username = events.created_by
    )
  );
CREATE POLICY "Event delete" ON events FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM event_users
      WHERE event_users.id = auth.uid()
        AND event_users.event_id = events.id
        AND event_users.username = events.created_by
    )
  );

-- EVENT ITEMS: Public SELECT; for INSERT/UPDATE/DELETE, only allow if current user is the event creator.
CREATE POLICY "Event items select" ON event_items FOR SELECT USING (
  EXISTS (SELECT 1 FROM events WHERE events.id = event_items.event_id)
);
CREATE POLICY "Event items insert" ON event_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM event_users
      WHERE event_users.id = auth.uid()
        AND event_users.event_id = event_items.event_id
        AND event_users.username = (SELECT created_by FROM events WHERE events.id = event_items.event_id)
    )
  );
CREATE POLICY "Event items update" ON event_items FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM event_users
      WHERE event_users.id = auth.uid()
        AND event_users.event_id = event_items.event_id
        AND event_users.username = (SELECT created_by FROM events WHERE events.id = event_items.event_id)
    )
  );
CREATE POLICY "Event items delete" ON event_items FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM event_users
      WHERE event_users.id = auth.uid()
        AND event_users.event_id = event_items.event_id
        AND event_users.username = (SELECT created_by FROM events WHERE events.id = event_items.event_id)
    )
  );

-- EVENT_USERS: A user can only select their own profile.
CREATE POLICY "Event users select" ON event_users FOR SELECT
  USING (id = auth.uid());
-- Allow insert if the new profile’s id matches auth.uid()
CREATE POLICY "Event users insert" ON event_users FOR INSERT
  WITH CHECK (id = auth.uid());

-- COMMITMENTS: Users may only access their own commitments.
CREATE POLICY "Commitments select" ON commitments FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY "Commitments insert" ON commitments FOR INSERT
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "Commitments update" ON commitments FOR UPDATE
  USING (user_id = auth.uid());
CREATE POLICY "Commitments delete" ON commitments FOR DELETE
  USING (user_id = auth.uid());
