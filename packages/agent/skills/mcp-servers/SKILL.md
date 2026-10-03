---
name: mcp-servers
description: 'MCP servers of the workspace: adding, testing, changing and removing one, and signing in to it. Load it before any of these.'
milibot:
  tools: [mcp_servers]
---

# MCP servers

- Check mcp_server_list first: the server may already be there (then test it, change it or sign in instead of adding another).
- Find out how the server runs from its documentation: a remote URL (streamable HTTP or SSE) or a command run in the VM (e.g. `npx -y <package>`). Prefer the remote URL when there is one.
- Every add, change and removal waits for the user's confirmation on a card in the chat; the tool returns the outcome (the test after an add or change). If the user has not decided when it returns, you get a note later: do not ask again.
- Tokens, API keys and passwords never go in the call as text. Get them with request_secret first, then pass `{{secret:NAME}}` as the value (e.g. `"Bearer {{secret:NOTION_TOKEN}}"`). Plain values are only for things that are not secret.
- When the server asks for a sign-in (OAuth), mcp_server_add starts it; otherwise call mcp_server_connect. The user signs in from a card in the chat, in the browser of their computer; the tool waits and tells you whether it connected, failed or expired. When it expired or failed, offer to try again.
- A server's tools reach the bots it is allowed for from their next turn, named `mcp__<slug>__<tool>`. By default only you may use it; pass `bots` when the user wants others (or `["all"]`) to have it.
- After connecting, tell the user in one line what the server can do now (from its tools), not the full list.

## Tool reference

Servers are named by name or id.

- `mcp_server_add {name, url?, command?, args?, headers?, env?, bots?, reason?}`: `url` for a remote server, or `command` + `args` for one run in the VM (exactly one of them). `headers` (remote) and `env` (command) are lists of `{name, value}`; a value with `{{secret:NAME}}` is stored as a secret. `name` is shown to the user (max 64). `reason`: one sentence on the card.
- `mcp_server_update {server, …}`: the same fields plus `enabled`; send only what changes. `headers`/`env` replace the whole list; an entry without `value` keeps the stored one.
- `mcp_server_remove {server, reason?}`, `mcp_server_test {server}`, `mcp_server_connect {server}`.
