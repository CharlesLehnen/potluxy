# Scripts

Run everything with the project conda env: `conda run --no-capture-output -n potluxy ...`

## Reusable (`skills/`)

| Script | What it does | Run |
|---|---|---|
| `skills/db_test/run_db_tests.sh` | Throwaway local Postgres + Supabase stub; loads `code/supabase_config.sql`, legacy seed data, every file in `code/migrations/` (twice, to prove re-runs are safe), then runs `test_security.sql` (takeover/leak/permission tests). | `claude/scripts/skills/db_test/run_db_tests.sh [--env potluxy] [--port 54329] [--keep]` |
| `skills/e2e/e2e_test.py` | Real `index.html`/`main.js` in headless Chromium; Supabase calls answered from a local Postgres with all migrations applied. Blocks ads/analytics. Covers create, join, commit, decline, sign-in, host tools, XSS and takeover attempts. | `conda run --no-capture-output -n potluxy python claude/scripts/skills/e2e/e2e_test.py [--headed] [--port 8765] [--pg-port 54330]` |

## One-time (`one_time/`)

| Date | Script | Purpose |
|---|---|---|
