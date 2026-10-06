---
name: plans-and-sessions
description: 'Work sessions and plans: opening a session for long work, writing a plan for approval, executing an approved one. Load it before any of these.'
milibot:
  tools: [plans]
---

# Plans and work sessions

## Work sessions

Open one with session_start, or through a plan (plans run in a session unless written with execution "chat", meant for a few quick steps; an approved plan opens its session by itself). The session runs in parallel with a long context of its own; the user follows it from a card and can talk to you there, and its result comes back here when it finishes.

- The goal is a short brief: the request, the decisions made with the user, the paths (folder, repo, the design or files to follow), what already exists and what is missing when the work started in the chat, and how to know it is done. The session does not see this conversation, but it runs on the same machine with your tools and reads the files itself: point to them, never read or paste code, designs or files into the goal.
- Open the session as soon as the work turns out to be long, without investigating first: investigating is the session's work.
- In the goal, the plan body, steps and the session's summary, refer to cards, boards, designs, plans and documents by their raw id (`bcd_…`, `dsg_…`, `kdoc_…`) and to files by their /workspace path, outside code: the user sees them as links.
- `project` is a Milibot project (project_list), not a folder name; the folder goes in `folder`.
- A session works in its own worktree when it has a repository (`repo`, or the project's only repository), else in an empty folder of its own. When the work has no repository but lives in a project folder (one to create or one that already exists), set `folder` on the plan or on session_start to that folder instead of writing the path only in the goal or body: the session then starts there and the user sees what changed in it.

## Writing the plan

Check plan_search for similar plans whose decisions you can reuse.

1. Investigate before writing, without changing anything but the repo's update (`git pull --ff-only` first: never plan over stale code). For each assumption the change breaks, find every place that depends on it (search, don't sample) and read the files you will change. Hand independent investigations to read-only helpers with subagent (several in one response run in parallel). For areas you can't reach, ask a teammate who knows them.
2. Ask with ask_user only what the user must decide.
3. Write the plan with plan_write, in the user's language, and send it with plan_submit (nothing reaches the user before that).

The body is for whoever executes it:

- Context: the problem, why now, and the decisions already made with the user.
- The approach you recommend (not a menu of alternatives), with concrete choices and why.
- Where: the files and functions to change and the existing ones to reuse, with their paths.
- Pitfalls you found: what breaks if done the obvious way.
- Verification: which tests cover what, and an end-to-end check that proves it works.
- No status, dates or estimates; the steps go in `steps`, not repeated in the body.

Code work ends with a step that opens the pull request and reports its link. Add no merge step unless the workspace allows merging or the user asks for it: the user merges it, and can allow merging when approving the plan.

Do not start the work until the plan is approved. When changes are requested, rewrite it (plan_write with its id) and submit again; when it is rejected, do not execute it.

## Executing

- Keep the plan's steps current with todo_write as you go, never all at the end.
- Steps you hand to another bot: it gets the plan and marks them itself with plan_step as it goes; name the steps in your message. When a bot's step is done and it did not mark it, mark it yourself.
- Finish every step or skip it with a reason: that completes the plan.

## Choosing the model

Work runs on your own model unless the user names one for it ("implement it with opus, effort high", "design it on gpt-5 with 1M of context"): then pass that choice to session_start, plan_write or subagent. Do not pick a model or effort on your own. The choice may be on another provider than yours (a session on Claude Code while you run on an API, or the other way round); when the user says where, pass `provider`. The tool answers with the model it resolved, or with the models that exist when the name is unknown or ambiguous: use list_models then, and ask the user only when the choice is still unclear.

## Tool reference

Plans are named by id or title; titles are short (max 120), everything in the user's language.

- `plan_write {title, summary, body, steps, plan?, execution?, project?, folder?, card?}`: `card` is the board card the plan does (boards skill); `summary` is what the plan does and why in 2–4 sentences (how plans are found later); `body` as above; `steps` are `[{title, detail?}]`, one concrete action each (detail: files, commands, criteria); `plan` is the id of your draft to rewrite (omit to create one); `execution` "session" (default) or "chat"; `project` defaults to the current project ("general" for none); `folder` is the absolute folder inside /workspace the work happens in when there is no repository (made when missing; omit to keep the draft's, "" to clear it).
- `plan_submit {plan}`: shows the plan as a card and waits for the decision; once approved, execute it right away.
- `plan_search {query?, status?, project?}`: `project` defaults to the current project plus general plans; a project name, "general" or "all".
- `session_start {title, goal, plan?, project?, repo?, folder?, card?, model?, effort?, context?, provider?}`: `card` is the board card the session works on; `plan` is the approved plan it executes (the session takes the plan's model when you pass none); `project` defaults to the current project ("general" for none); `repo` (a clone's name in /workspace/repos or its URL) gives the session its own worktree and branch; `folder` (ignored with `repo`; defaults to the plan's) is the absolute folder inside /workspace the session works in, made when missing — not inside /workspace/repos, /workspace/worktrees or the folder of another open session.
- Model arguments (session_start, plan_write, subagent), only when the user asked: `model` is what the user called it ("opus", "sonnet 5.5", "gpt-5 mini") or an exact id from list_models; `effort` is `low`, `medium`, `high`, `xhigh`, `max` or another level list_models shows for that model (without `model`, your current model at that effort); `context` limits the context the work may fill ("256k", "1m"); `provider` names where it runs ("Claude Code", "OpenRouter"). On plan_write they set the model the plan's session runs on (the user can still change it when approving).
- `list_models {query?}`: the models of every provider, with their context size and efforts.
