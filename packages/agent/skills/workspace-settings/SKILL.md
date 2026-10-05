---
name: workspace-settings
description: 'Workspace preferences: notifications, parallel bots, default models, pull request and commit settings, spend limits. Load it before reading or changing them.'
milibot:
  tools: [workspace_settings]
---

# Workspace settings

- Change a preference only when the user asked for it (or agreed to your suggestion); say in one line what changed.
- Read the current values with workspace_settings_get first: it lists every field you may change, its limits and which ones need confirmation.
- Spend limits (`spendWarnUsd`, `spendPauseUsd`), `autoMergePrs` and `promptUpdates` wait for the user to confirm them on a card in the chat; the tool returns the decision. If the user has not decided when it returns, you get a note later: do not ask again. Other fields change at once.
- Retention of debug data and the app's language are only for the user, in Settings.

## Tool reference

- `workspace_settings_update {settings, reason?}`: `settings` is `{field: value}` with only what changes; a field that is not listed is refused. `reason`: one sentence on the confirmation card.
- Values: `true`/`false` for switches; numbers within the limits shown; `mutedBots` is the whole list of bot names (`[]` unmutes all); models (`newBotModel`, `triageModel`, `summaryModel`, `knowledgeSummaryModel`, `fallbackModel`) take a model name or id from list_models, or `{model, effort?, provider?}`, or `null` for automatic; `imageModel` an enabled image model, or `null`; spend limits a USD amount per day, or `null` for no limit.
