---
name: boards
description: 'Kanban boards for goals of several sessions or plans: creating one, working its cards, searching them. Load it before any of these.'
milibot:
  tools: [boards]
---

# Boards

A board is a kanban you keep for one large goal. Each card is a piece of that goal big enough to deserve its own plan or work session; the board holds the whole picture so no single plan grows too large and nothing is lost between sessions. The user sees the boards in the app, moves cards, comments and adds images; other bots of the team read and work the same boards.

## Making the board

Before creating one, look for a board of the same goal with board_search (or board_list): continue it instead of starting another.

1. Map the scope first (read the code, the documents, what exists), so the cards reflect the real parts, not guesses. Ask the user with ask_user only what changes the split.
2. board_create with a title that names the goal and a `summary` of what it covers and why (2–4 sentences: how the board is found later), plus the cards you already know.
3. Cards are independently deliverable pieces, titled by their outcome ("Customer registration screen", "Remove the legacy bundle"). `summary`: one or two sentences. `body`: what "done" means (acceptance criteria), constraints and references (files, links, screenshots). Keep details for the card's own plan; do not plan every card upfront.
4. Order the To do column by dependency and priority: what unblocks others first. Set due dates only when the user gives them.

## Labels

Every card you create gets labels. Reuse the board's labels (`board_get` lists them) and add a new one only when none fits. When the board labels both type (Bug, Front, Backend…) and priority, the card gets one of each. Copying or recreating a card on another board carries its labels too, with its title, summary, body, assignees and due date. Change a label's name or color with `board_label_write` when the user asks; deleting labels is the user's, in the app.

Tell the user in a line what the board covers; its card in the chat opens it.

## Working a card

1. board_card_get before starting: read the body and every comment, they may carry decisions or changes from the user or another bot.
2. Size decides how to do it, as for any work:
   - long: session_start `card`, or plan_write `card` when the user should decide something first (the session, its plan and pull requests get linked to the card by themselves);
   - small: do it directly and move the card yourself.

   The card moves to "doing" when its session opens; move it with board_card_write `status` otherwise.

3. When it is finished and verified, move it to "done". A card that will not be done moves to "dropped" with a comment saying why.
4. Work discovered on the way becomes new cards; a card that turned out bigger than planned can be split.

When every card is done or dropped the board completes by itself. Archive a board (board_update `archived: true`) when the user asks or a completed board is no longer useful; archived boards leave the lists but stay searchable.

## Comments

Comments are for what the next person working the card needs: decisions, deviations from the plan or the body, blockers, open questions. One to three sentences, in the user's language. Never a summary of what you did (the plan, session and pull request already show that) and never a progress log.

In comments, bodies and the chat, refer to another card, board, plan, session or design by its raw id (`bcd_…`, `brd_…`) and to files by their /workspace path: the app turns them into links with the current name, so the name need not be repeated.

## Tool reference

Boards and cards are named by id or title; everything in the user's language.

- `board_create {title, summary, project?, due?, cards?}`: `cards` are `[{title, summary?, body?, due?, labels?}]` in To do (`labels` by name, as in `board_card_write`); `project` defaults to the current project ("general" for none); `due` is `YYYY-MM-DD`.
- `board_list {archived?, project?}`: boards in the order the user keeps them, with their counts, status and due date; `archived: true` includes archived ones.
- `board_get {board}`: the board's labels with their colors and the cards by column, with ids, summaries, assignees, labels, links and comment counts.
- `board_update {board, title?, summary?, due?, archived?, position?, doing_limit?}`: `due: ""` clears it; `archived: false` brings a board back. `position` moves the board in the list of boards (0 = top, counted among all boards, archived included); change it only when the user asks, since the order is theirs. `doing_limit` caps how many cards should be in Doing at once (1–50, 0 removes it); it only warns, nothing is blocked, and a result that takes Doing past it says so: finish or move a card before starting another.
- `board_delete {board}`: deletes the board and its cards for good. Only when the user asks; prefer archiving.
- `board_card_write {card | board, title?, summary?, body?, status?, due?, before?, assignees?, labels?}`: with `board` and `title` adds a card; with `card` changes one (send only what changes). `status` is todo, doing, done or dropped; `before` is the card it goes before in its column ("" = the end). `assignees` replaces who is on the card: bot names, and "user" for the user (moving a card to doing adds you by itself). `labels` replaces the card's labels by name; a name the board doesn't have yet becomes a new label (reuse the board's labels shown by `board_get`). With `card` and a different `board`, the card moves to that board (same column unless `status` says otherwise, `before` places it there) keeping its id, comments, links, assignees, due date and images; its labels follow by name and a comment records the move. Archived boards take no cards. Images in the body are markdown with a /workspace path (`![screen](/workspace/shots/old.png)`) or an https URL; they are stored with the card.
- `board_label_write {board, label, name?, color?}`: `label` is a label's name or id; `name` renames it, `color` recolors it (gray, red, orange, yellow, green, teal, blue, violet or pink). A `label` the board doesn't have is added, with `color` if given. The app shows the change at once.
- `board_card_get {card}`: body, links, comments, and the images as /workspace paths you can open.
- `board_comment {card, text}`: at most 500 characters.
- `board_link {card, kind, ref, label?, remove?}`: `kind` plan, session, design (their id or title), pr or url (the URL), commit (the sha; `label` its message). Plans and sessions opened with `card` and their pull requests are linked by themselves.
- `board_search {query, archived?, project?}`: boards and cards whose title, summary or body match, best first.
