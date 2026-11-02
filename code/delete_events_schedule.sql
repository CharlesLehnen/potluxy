select cron.schedule(
  'potluxy-nightly-maintenance',
  '15 4 * * *',
  $$ select * from public.potluxy_nightly_maintenance(interval '7 days', 250, 5000, false); $$
);
