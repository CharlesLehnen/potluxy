## Git and version control

- **Never run git commit, git push, git reset, git rebase, or any command that alters repository history.** The user makes all commits.
- You may create, edit, and delete files freely. Leave version control to the user.

## Documents

- Guides, how-tos, and other documents written for the user go in `claude/documents/`.

## Database (SQL)

- Live database changes go in a new, re-runnable file in `code/migrations/` (the user runs it in the Supabase SQL editor).
- **Whenever any SQL changes, also edit `code/supabase_config.sql` as if the change had been part of the initial deployment from the start.** That file is the complete current schema (fresh install) and the single place to read all database functionality. No legacy/upgrade steps belong in it.
- `archive/supabase_config_original_2025.sql` is the frozen pre-migration baseline; never edit it.
- `claude/scripts/skills/db_test/run_db_tests.sh` fails if `code/supabase_config.sql` differs from "original + all migrations", so run it after every SQL change.

## Scripts

Before writing any new script, read `claude/scripts/SKILLS.md` to check if one already exists. Modify existing scripts rather than rewriting from scratch. If you create a new script:
- Reusable → `claude/scripts/skills/`, add a row to SKILLS.md
- One-time → `claude/scripts/one_time/`, add a row with the date


## Python and Conda
- Always use conda environment to run. Whenever you download a new library you must add it in an OS agnostic way to requirements.txt and environment.yml
- **Every script that prompts for input must also accept all required inputs as command-line flags** (e.g. `argparse --input`/`--output`), so Claude and the user can both run it non-interactively in any terminal or dev-container environment. Interactive prompts are a convenience layer on top of the flags, not a replacement for them.