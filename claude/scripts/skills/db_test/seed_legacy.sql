-- Data shaped like the pre-migration app produced it (mailinator alias logins).
-- Jane (host, real password), Bob (guest, default 'no-password'), Sam (anonymous decline).
INSERT INTO auth.users (id, email, encrypted_password) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'jane_doe.legacy-abc@mailinator.com', extensions.crypt('secret1', extensions.gen_salt('bf'))),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'bob.legacy-abc@mailinator.com',      extensions.crypt('no-password', extensions.gen_salt('bf')));

INSERT INTO public.events (id, event_name, slug, created_by, event_location, collect_real_emails)
VALUES ('eeeeeeee-0000-0000-0000-000000000001', 'Legacy Friendsgiving', 'legacy-abc', 'Jane_Doe', '123 Private St', true);

INSERT INTO public.event_users (id, event_id, username, real_email, rsvp_status, wants_reminders) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'Jane_Doe', 'jane@example.com', 'yes', true),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'eeeeeeee-0000-0000-0000-000000000001', 'Bob',      'bob@example.com',  'yes', true),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'eeeeeeee-0000-0000-0000-000000000001', 'Sam',      NULL,               'no',  false);

INSERT INTO public.event_items (id, event_id, item_name, quantity_required) VALUES
  ('11111111-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'Pie', 2);

INSERT INTO public.commitments (event_id, user_id, item_id, quantity) VALUES
  ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 1);
