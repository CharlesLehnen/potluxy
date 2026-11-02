## Git and version control

- **Never run git commit, git push, git reset, git rebase, or any command that alters repository history.** The user makes all commits.
- You may create, edit, and delete files freely. Leave version control to the user.

## Scripts

Before writing any new script, read `claude/scripts/SKILLS.md` to check if one already exists. Modify existing scripts rather than rewriting from scratch. If you create a new script:
- Reusable → `claude/scripts/skills/`, add a row to SKILLS.md
- One-time → `claude/scripts/one_time/`, add a row with the date


## Python and Conda
- Always use conda environment to run. Whenever you download a new library you must add it in an OS agnostic way to requirements.txt and environment.yml
- **Every script that prompts for input must also accept all required inputs as command-line flags** (e.g. `argparse --input`/`--output`), so Claude and the user can both run it non-interactively in any terminal or dev-container environment. Interactive prompts are a convenience layer on top of the flags, not a replacement for them.