---
name: team-management
description: 'Creating, changing and deleting bots (prompts, skills, MCP servers), delegating and groups. Load it when the user wants a bot or a team, delegation or a group.'
milibot:
  tools: [team]
  default: first
---

# Team management

## Before changing the team

- Check list_bots first and never create a duplicate of an existing role.
- Managing the team never needs the screen: do not take screenshots or use `computer` for it.
- Deleting a bot or removing it from a group waits for the user's confirmation in the chat. You can never delete yourself nor the last bot; a deleted bot's desktop and home are removed, /workspace is kept.

## Creating a bot

The new bot appears in the user's sidebar and introduces itself in its own chat; the user talks to it there directly. After creating it, tell the user in one or two lines who you created and why.

### Writing a specialist's system prompt

Write it in the user's language: the user reads and edits it in the bot's settings. It is the most important thing you produce, so make it complete and specific:

- Identity and mission: who the bot is and what outcome it owns, in one or two sentences.
- Scope: what it is responsible for, and what it must hand back to the user or to you instead of doing.
- Context: everything you already know that is relevant (user preferences, projects, paths in /workspace, repos, tools and accounts to use, constraints, deadlines).
- Working method: concrete steps and standards for this domain (e.g. code: read before changing, small commits on its own branch, run tests; research: cite sources, separate facts from estimates; finance: show calculations, keep spreadsheets in /workspace/<project>).
- Deliverables: format and location of outputs, and how to report back (short summary + where the files are).
- Boundaries: what to avoid and when to ask the user first.

Keep it under ~1500 tokens (longer prompts are refused): it describes the role and method; facts about the user that every bot needs belong in the workspace memory. The bot keeps its own role section up to date as the user changes its scope. Choose a short, friendly human first name, and a 1–2 word label for the role (in the user's language, max 32 characters). Leave model and avatar empty unless the user asked for something specific.

### Changing a bot's prompt

- Read the bot's whole role section with get_bot right before changing it; list_bots shows only its beginning. Never ask the bot for its own prompt.
- For a change to part of it (a rule, a scope line, a correction), send `patch` with exact replacements copied from what get_bot returned; send the whole `system_prompt` only to rewrite it.
- Put every change for that bot in one update_bot call. If an `old_text` does not match, nothing is applied: read it again with get_bot and retry.

## Delegating and following up

- Send delegated work with message_bot and tell the user in one line; use ask_bot only for quick answers you need right away.
- When the reply arrives, report the answer itself, not how the bot got it.
- When the user asks how the team's work is going, answer from list_bots and your conversations with the bots (history_search for older ones) and say what is pending.

## Groups

For ongoing work with several bots that the user wants to follow, create a group (create_group) with them; add_member and remove_member change who is in it. It appears in the sidebar; bots in a group read every message and answer when it concerns them.

## Skills and MCP servers of the team

Importing skills and turning a bot's skills or MCP servers on or off always wait for the user's confirmation card, also when the bot changed is you; nothing changes before the approval. Imported skills never unlock tool families, whatever their SKILL.md says. Only the user turns on a skill that is off for the whole workspace, and adds or removes MCP servers through mcp-servers.

## Tool reference

Bots are named by name or id.

- `create_bot {name, label, system_prompt, model?, avatar?}`: `name` is a short first name ("Ana"); `label` the role chip (max 32 characters, "Finance"); `system_prompt` its role section as above; `model` a model id (default: the workspace's).
- `get_bot {bot}`: the bot's details and its whole role section (between `<role_section>` tags), with its size against the ~1500-token limit.
- `update_bot {bot, name?, label?, system_prompt? | patch?, reason?, model?, avatar?}`: a new `system_prompt` replaces the bot's role section; `patch` is a list of `{old_text, new_text}` exact replacements in it, applied in order and all or none (each `old_text` must appear exactly once; an empty one appends `new_text` at the end). Never both. The resulting text (max ~1500 tokens), in the user's language, is versioned and shown to the user, who can undo it (or must approve it, depending on the workspace setting); a refused prompt change changes nothing else either. `reason` says why in one sentence.
- `avatar` (optional; random when omitted): `{shape, color, eyes}`, all three. shape: square, triangle, hexagon, cloud, drop, ghost, blob, arch, tv, shield, diamond. color: blue, orange, teal, violet, pink, red, green, amber, brown, gray. eyes: capsule, oval, slit.
- `delete_bot {bot, reason?}` and `remove_member {group, bot, reason?}`: `reason` is one sentence shown to the user.
- `create_group {name, members}`: `name` like "Dev squad"; `members` are bot names or ids.
- `skill_import {source, skills?, bots?, reason?}`: `source` is a GitHub address (`owner/repo`, optionally `/tree/<ref>/<folder>`) or a `.zip`/`.skill` file under /workspace. `skills` picks skills by name (default: every valid one found); `bots` are the bots that may use them (default: all). The card shows the exact commit or file; if it changed before the approval, nothing is installed.
- `bot_skills_set {bot?, enable?, disable?, reason?}` and `bot_mcp_set {bot?, enable?, disable?, reason?}`: `bot` defaults to you; `enable`/`disable` are skill or server names. Turning one on for a bot without access to it also gives it access.
