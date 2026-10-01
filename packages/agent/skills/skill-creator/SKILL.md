---
name: skill-creator
description: 'Writing and saving skills. Load it when the user asks to turn something into a skill or to remember how to do a kind of task, or you found a reusable procedure.'
milibot:
  tools: [skills]
---

# Creating skills

A skill teaches a bot how to do one kind of task. Bots see only the name and description in their catalog and load the rest with skill_load when the task comes up, so the instructions can be detailed without costing anything until then.

## Format

- `name`: lowercase letters, digits and hyphens, max 64 characters (e.g. `monthly-close`). It is also the folder name.
- `description`: what the skill does AND when to load it, with the words a request for that task would use. This is the only part a bot reads before deciding, so be specific ("Load it before closing the monthly accounts: bank reconciliation, invoices, the cash-flow sheet"), not vague ("Finance helper"). Keep it to one or two sentences (about 200 characters; the catalog cuts it at 250, the limit is 1024): every bot with the skill pays for it on every request.
- `body`: the instructions in markdown, without frontmatter. skill_save writes the SKILL.md frontmatter.

## Writing the instructions

- Imperative and concrete: the steps, the decisions and the checks, in order. Add what is not obvious (paths, accounts, conventions, pitfalls you hit); leave out what any capable agent already knows.
- Keep SKILL.md focused (up to a few hundred lines; max 60 KB). Move long references, examples and templates to separate files and say in the body when to read each one (skill_read).
- Deterministic or repetitive work (converting files, generating reports, calling an API) goes into scripts in the skill (e.g. `scripts/build.py`); the body says how to run them. Skill files are in the VM at /usr/local/share/milibot/skills/<name>/ (read-only; copy a file to /workspace to change it).
- Never put secrets in a skill: refer to them by name (`{{secret:NAME}}`, `$MILIBOT_SECRETS_DIR/NAME`).
- Write it in the language the user uses with you, unless it is meant for code or tools.

## Saving

- skill_save with name, description and body, plus `files` for small text files (`[{path, content}]`, paths relative to the skill such as `scripts/run.py`), or `from_path` with a folder you prepared under /workspace (its files are copied, its SKILL.md is used when body is omitted). Limits: 500 files and 20 MB per skill.
- scope "me" (the default for a new skill) keeps it to you; "all" offers it to every bot. You can only change or delete (skill_delete) the skills you created.
- Test it: load it with skill_load and check that the instructions and files are what a bot needs, then tell the user in one line what the skill does.
