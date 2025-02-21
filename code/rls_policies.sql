-- Enable RLS on Events Table
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only access their own events"
ON events FOR SELECT
USING (
  EXISTS (
    SELECT 1 
    FROM users 
    WHERE users.event_id = events.id
  )
);

-- Enable RLS on Event Items Table
ALTER TABLE event_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only see items for their event"
ON event_items FOR SELECT
USING (
  EXISTS (
    SELECT 1 
    FROM users 
    WHERE users.event_id = event_items.event_id
  )
);

-- Enable RLS on Users Table
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only access their own event"
ON users FOR SELECT
USING (
  auth.uid() = id
);

-- Enable RLS on Commitments Table
ALTER TABLE commitments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only see their own commitments"
ON commitments FOR SELECT
USING (
  EXISTS (
    SELECT 1 
    FROM users 
    WHERE users.id = commitments.user_id
  )
);
