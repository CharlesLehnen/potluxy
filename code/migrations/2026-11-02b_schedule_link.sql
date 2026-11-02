-- ============================================================================
-- Potluxy: optional "find a time" link (when2meet etc.) — 2026-11-02
--
-- Run in the Supabase SQL editor AFTER 2026-11-02_security_rebuild.sql.
-- Safe to re-run. Adds events.schedule_url and returns/saves it in the same
-- three functions that already handle invite_url (bodies otherwise unchanged;
-- CREATE OR REPLACE keeps their existing grants).
-- ============================================================================

BEGIN;

ALTER TABLE public.events ADD COLUMN IF NOT EXISTS schedule_url TEXT;

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

NOTIFY pgrst, 'reload schema';

COMMIT;
