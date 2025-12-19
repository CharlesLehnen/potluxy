select * from public.potluxy_nightly_maintenance(
  interval '0 seconds',  -- grace
  250,                   -- max events
  5000,                  -- max orphans
  true                   -- dry run
);
