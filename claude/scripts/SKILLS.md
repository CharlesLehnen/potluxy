# Scripts

Run everything with the project conda env: `conda run --no-capture-output -n potluxy ...`

## Reusable (`skills/`)

| Script | What it does | Run |
|---|---|---|
| `skills/db_test/run_db_tests.sh` | Throwaway local Postgres + Supabase stub. Upgrade path: loads `archive/supabase_config_original_2025.sql`, legacy seed data, every file in `code/migrations/` (twice, to prove re-runs are safe), then runs `test_security.sql` (takeover/leak/permission tests). Sync check: builds a second DB from `code/supabase_config.sql` alone and fails if its schema dump differs from the upgraded one. | `claude/scripts/skills/db_test/run_db_tests.sh [--env potluxy] [--port 54329] [--keep]` |
| `skills/e2e/e2e_test.py` | Real `index.html`/`main.js` in headless Chromium; Supabase calls answered from a local Postgres built from `code/supabase_config.sql` (fresh install). Blocks ads/analytics. Covers create, join, pick-before-name, commit, decline, sign-in, host tools, Partiful link, phone layout, XSS and takeover attempts. `--screenshots DIR` saves desktop + phone screenshots for a visual check. | `conda run --no-capture-output -n potluxy python claude/scripts/skills/e2e/e2e_test.py [--headed] [--port 8765] [--pg-port 54330] [--screenshots DIR]` |

## One-time (`one_time/`)

| Date | Script | Purpose |
|---|---|---|
