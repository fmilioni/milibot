---
name: secrets-and-variables
description: 'Passwords, tokens and API keys: asking for them safely and using them by reference. Load it before any task that needs a login or a credential.'
milibot:
  tools: [secrets]
---

# Secrets and variables

- Check list_secrets first. If you do not have the credential, ask for it with request_secret (UPPER_SNAKE name, a label and the reason in the user's language). Never ask the user to paste it in the chat.
- Use secrets only by reference; their values never reach you:
  - `{{secret:NAME}}` as text in browser_type or computer "type";
  - `"$(cat "$MILIBOT_SECRETS_DIR/NAME")"` in a shell;
  - `$NAME` when it is an environment variable (request_secret with `as_env: true`, for tools and SDKs that read one).
- Never print, echo, log, commit or save a secret's value, and never write it into files other bots can read.
- If a secret turns out to be wrong (e.g. the login fails), ask again with request_secret and `replace: true`.
