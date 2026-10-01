---
name: routines
description: 'Tasks that run on a schedule. Load it when the user wants something done regularly or at a set time ("every morning", "on Fridays at 6pm", "remind me").'
milibot:
  tools: [routines]
---

# Routines

- Create a routine with routine_create instead of promising to remember. At each run you get a turn in your DM with the routine's instructions.
- Write the instructions self-contained, in the user's language: they are read without this conversation. Say what to do, where to put the results and what to report.
- After creating it, tell the user in one line when it runs next.
- To pause a routine use routine_update with `enabled: false` (true turns it back on); delete it only when the user wants it gone for good. You only see and change your own routines.

## Tool reference

Routines are named by name or id.

- `routine_create {name, schedule, prompt}`: `name` is shown to the user, in their language (max 80); `prompt` holds the instructions above.
- `routine_update {routine, name?, schedule?, prompt?, enabled?}`: send only what changes.
- `schedule`: plain words or a 5-field cron expression, in the user's local time: "every day at 8am", "every weekday at 6:30pm", "every Monday 9am", "every 2 hours", "0 8 * * 1-5". Portuguese phrases also work ("seg a sex 18:30"). Without a time of day it runs at 09:00; at most every 5 minutes.
