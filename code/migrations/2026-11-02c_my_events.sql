-- ============================================================================
-- Potluxy: "My events" list — 2026-11-02
--
-- Run in the Supabase SQL editor AFTER 2026-11-02b_schedule_link.sql. Safe to re-run.
-- Adds public.my_events(): the events this browser created or RSVP'd to.
-- Read-only; uses the existing browser↔guest links in private.member_sessions.
-- ============================================================================

BEGIN;

-- Events this browser created or responded to (via private.member_sessions).
CREATE OR REPLACE FUNCTION public.my_events()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := private.uid();
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'slug', e.slug,
      'name', e.event_name,
      'date', e.event_date,
      'time', left(e.event_time::text, 5),
      'location', e.event_location,
      'host', e.created_by,
      'is_host', u.username = e.created_by,
      'rsvp', u.rsvp_status,
      'deleting', e.delete_requested_at IS NOT NULL,
      'going', (SELECT count(*) FROM event_users g WHERE g.event_id = e.id AND g.rsvp_status = 'yes'),
      'items', (SELECT count(*) FROM event_items i WHERE i.event_id = e.id),
      'covered', (
        SELECT count(*) FROM event_items i
        WHERE i.event_id = e.id
          AND (SELECT COALESCE(sum(c.quantity), 0) FROM commitments c WHERE c.item_id = i.id) >= i.quantity_required
      ),
      'mine', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('name', i.item_name, 'qty', c.quantity) ORDER BY lower(i.item_name))
        FROM commitments c JOIN event_items i ON i.id = c.item_id
        WHERE c.user_id = u.id
      ), '[]'::jsonb)
    ) ORDER BY e.event_date NULLS LAST, e.created_at DESC)
    FROM private.member_sessions s
    JOIN public.events e ON e.id = s.event_id
    JOIN public.event_users u ON u.id = s.member_id
    WHERE s.auth_uid = v_uid
  ), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION public.my_events() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_events() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
