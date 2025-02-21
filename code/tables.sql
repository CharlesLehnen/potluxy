-- EVENTS TABLE
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- EVENT ITEMS TABLE (Items Needed Per Event)
CREATE TABLE event_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    item_name TEXT NOT NULL,
    quantity_required INT NOT NULL,
    quantity_committed INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(event_id, item_name)
);

-- USERS TABLE (Per Event)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    password TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(event_id, username)
);

-- COMMITMENTS TABLE (User Commitments)
CREATE TABLE commitments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    item_id UUID NOT NULL REFERENCES event_items(id) ON DELETE CASCADE,
    quantity INT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
