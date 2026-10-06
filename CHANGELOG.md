# Changelog

## [0.4.0](https://github.com/fmilioni/milibot/compare/v0.3.0...v0.4.0) (2026-10-06)

### Features

* close a session handed off to another bot and the one a new session for the same work replaces ([#44](https://github.com/fmilioni/milibot/issues/44)) ([f8a1819](https://github.com/fmilioni/milibot/commit/f8a1819801238aabcbb90fa74e7014400020e924))
* **daemon:** remove worktrees of finished work automatically ([#55](https://github.com/fmilioni/milibot/issues/55)) ([446294d](https://github.com/fmilioni/milibot/commit/446294d7656d0dd8f677330c9f0434108ea2e011))
* **desktop:** highlight changed elements and comment on one with Alt + click ([#42](https://github.com/fmilioni/milibot/issues/42)) ([cf9e859](https://github.com/fmilioni/milibot/commit/cf9e859d8785b4cf63df11a04cedefea0d971cd1))
* **desktop:** keep the computer from sleeping while bots work ([#51](https://github.com/fmilioni/milibot/issues/51)) ([1c89a18](https://github.com/fmilioni/milibot/commit/1c89a180d98622529c315795cb1bb24f7a03a584))
* **desktop:** update the app by itself from GitHub releases ([#59](https://github.com/fmilioni/milibot/issues/59)) ([797da1f](https://github.com/fmilioni/milibot/commit/797da1f827e6aba7016d029cec71a7c2a2ace941))
* let bots read the VM status ([#50](https://github.com/fmilioni/milibot/issues/50)) ([58b6078](https://github.com/fmilioni/milibot/commit/58b60789991712a5f605cc76e313eeda231b6471))
* let bots read their daemon log and log turns and status changes ([#45](https://github.com/fmilioni/milibot/issues/45)) ([66c4e7f](https://github.com/fmilioni/milibot/commit/66c4e7f6fc941aa17510223ec7c0c1351b696efc))
* let bots recolor, rename and add board labels and label new board cards ([#49](https://github.com/fmilioni/milibot/issues/49)) ([a98709b](https://github.com/fmilioni/milibot/commit/a98709bedec923868908021d79eeecdc27d2c68e))
* let team managers import skills and switch bot skills and MCP servers with confirmation ([#54](https://github.com/fmilioni/milibot/issues/54)) ([fbf203f](https://github.com/fmilioni/milibot/commit/fbf203f4cbeb4a712cc060038ff64221a81d9268))
* let the team manager read a bot's whole prompt and edit it in parts ([#53](https://github.com/fmilioni/milibot/issues/53)) ([eb4333a](https://github.com/fmilioni/milibot/commit/eb4333a761c4b049b113594bf8cca2f7f6d5c0c5))
* open ids and /workspace paths written in text from anywhere in the app ([#52](https://github.com/fmilioni/milibot/issues/52)) ([3faf6bf](https://github.com/fmilioni/milibot/commit/3faf6bf7959add1472ffd363dfb8ccaafb9fef64))
* redesign boards with filters, a Doing limit, a stable order and moving cards ([#41](https://github.com/fmilioni/milibot/issues/41)) ([87a10d5](https://github.com/fmilioni/milibot/commit/87a10d5df26e9ed6c117d039bc2defdb91e24b16))

### Bug Fixes

* **agent:** show the bot as available once no lane works ([#43](https://github.com/fmilioni/milibot/issues/43)) ([1fafdc5](https://github.com/fmilioni/milibot/commit/1fafdc513e9c46cb8b0848df1942b6d3f7acc7bb))
* **agent:** show the working row in internal conversations while a session runs ([#58](https://github.com/fmilioni/milibot/issues/58)) ([7d24f28](https://github.com/fmilioni/milibot/commit/7d24f2867c240dccbf6beb8786338c9c044861a0))
* **daemon:** match board label names ignoring the case of accented letters ([#57](https://github.com/fmilioni/milibot/issues/57)) ([06a7f83](https://github.com/fmilioni/milibot/commit/06a7f833032dc892b8fffcc8185a6ecc8b3f56d1))
* **desktop:** keep the diff file header opaque on hover and space the file filter ([#46](https://github.com/fmilioni/milibot/issues/46)) ([e1f8c6c](https://github.com/fmilioni/milibot/commit/e1f8c6cc101c8d1db38ad98083e6cb221793dea2))
* **desktop:** keep the DM working row steady while sessions run in parallel ([#48](https://github.com/fmilioni/milibot/issues/48)) ([1900de8](https://github.com/fmilioni/milibot/commit/1900de8fd5cdfe26ee4dc10d5d6f3220de0aa5a9))
* **desktop:** make URLs clickable in chat cards ([#39](https://github.com/fmilioni/milibot/issues/39)) ([5c0d237](https://github.com/fmilioni/milibot/commit/5c0d2371f87a0e8475a1ed3d61a82b6279c76f12))
* **desktop:** never show a negative VM uptime right after it starts ([#56](https://github.com/fmilioni/milibot/issues/56)) ([84d25ce](https://github.com/fmilioni/milibot/commit/84d25ce67de4d0b10c11a88af5d4590942e183f4))
* **desktop:** open only http(s) URLs from the app ([#47](https://github.com/fmilioni/milibot/issues/47)) ([dc92386](https://github.com/fmilioni/milibot/commit/dc9238631e971889663148dc5501d2c8e45f23b4))
* **desktop:** update the VM panel as soon as the screen is given back ([#40](https://github.com/fmilioni/milibot/issues/40)) ([030b6b6](https://github.com/fmilioni/milibot/commit/030b6b63b7e7d2904329825d9321d5452bad76a5))

## [0.3.0](https://github.com/fmilioni/milibot/compare/v0.2.2...v0.3.0) (2026-10-05)

### Features

* **agent:** let bots change their own model and reasoning effort ([#18](https://github.com/fmilioni/milibot/issues/18)) ([c3d7d0a](https://github.com/fmilioni/milibot/commit/c3d7d0af4cb6373799f0b5b9d98eda1ce3954252))
* **agent:** let bots merge and remove outdated or repeated memory notes ([#37](https://github.com/fmilioni/milibot/issues/37)) ([9064af7](https://github.com/fmilioni/milibot/commit/9064af739c36c986b7f57bc4aad02472a35a4c97))
* **agent:** make bots follow the repository's CLAUDE.md and AGENTS.md on every provider ([#21](https://github.com/fmilioni/milibot/issues/21)) ([ac99a79](https://github.com/fmilioni/milibot/commit/ac99a79332375d4a6557126fdb3963ba2a691a4e))
* **desktop:** open the collapsed plan and changes panel over the session chat ([#34](https://github.com/fmilioni/milibot/issues/34)) ([da0b50d](https://github.com/fmilioni/milibot/commit/da0b50da28c781dbb12835d3ab5c8dc8875b8f58))
* keep bots aware of their work across conversations and wake them with what they set aside ([#27](https://github.com/fmilioni/milibot/issues/27)) ([7e961c0](https://github.com/fmilioni/milibot/commit/7e961c03c7b2364eec30c51fc65ec4166f7fd9de))
* let bots add, test, change and remove MCP servers and sign in to them with the user's confirmation ([#25](https://github.com/fmilioni/milibot/issues/25)) ([d757d23](https://github.com/fmilioni/milibot/commit/d757d23653ac99263e4d46c9e87a45c4d56ae47a))
* let bots read and change workspace settings, with the user's confirmation for spend limits, merging and prompt updates ([#30](https://github.com/fmilioni/milibot/issues/30)) ([902f38d](https://github.com/fmilioni/milibot/commit/902f38da068832604a0a8fd61035cea4fda97894))

### Bug Fixes

* **agent:** deliver a bot's message to a stopped bot in their private conversation ([#31](https://github.com/fmilioni/milibot/issues/31)) ([a180b3d](https://github.com/fmilioni/milibot/commit/a180b3df44c8560f4b2508a92f3b253e1c1feade))
* **agent:** keep idle watch alerts until the watcher's turn runs ([#38](https://github.com/fmilioni/milibot/issues/38)) ([165bf3c](https://github.com/fmilioni/milibot/commit/165bf3c0d50170efc408bd1e9bd4e68de562dc3a))
* **daemon:** keep linked pull request statuses current after merges and closes ([#23](https://github.com/fmilioni/milibot/issues/23)) ([7cc59ab](https://github.com/fmilioni/milibot/commit/7cc59abbe787ac439eeb1f1afe8cc240087c8829)), closes [#21](https://github.com/fmilioni/milibot/issues/21) [#18](https://github.com/fmilioni/milibot/issues/18) [#21](https://github.com/fmilioni/milibot/issues/21)
* **daemon:** redact secrets echoed back in MCP server errors ([#28](https://github.com/fmilioni/milibot/issues/28)) ([0a9b8d0](https://github.com/fmilioni/milibot/commit/0a9b8d02095274ae6a4503cc75f6b5131ec603ed))
* **daemon:** redact tokens echoed without their auth scheme ([#29](https://github.com/fmilioni/milibot/issues/29)) ([60516d7](https://github.com/fmilioni/milibot/commit/60516d746481e852864d19cecea5e9d7f2fa6ea1)), closes [#28](https://github.com/fmilioni/milibot/issues/28)
* **desktop:** clarify that the merge options let bots merge PRs ([#32](https://github.com/fmilioni/milibot/issues/32)) ([00ea124](https://github.com/fmilioni/milibot/commit/00ea124d4430e5af51a5aa07d497c2e9c8cf92f4))
* **desktop:** drop the dark ring around bot avatars in card assignees ([#24](https://github.com/fmilioni/milibot/issues/24)) ([e98fa79](https://github.com/fmilioni/milibot/commit/e98fa79a87e14980a82ebdc3e6daa472496e800a))
* **desktop:** end the session chat's turn as soon as the session is stopped ([#26](https://github.com/fmilioni/milibot/issues/26)) ([cea2877](https://github.com/fmilioni/milibot/commit/cea28770667ad2a2372176e311b733d247147a05))
* **desktop:** keep board progress track visible on the selected list item ([#35](https://github.com/fmilioni/milibot/issues/35)) ([1aa0dc5](https://github.com/fmilioni/milibot/commit/1aa0dc539fd351fee17ef6cca1bb1e9662d70f5d))
* **desktop:** keep the session changes list steady while the session edits files ([#19](https://github.com/fmilioni/milibot/issues/19)) ([9ca99c0](https://github.com/fmilioni/milibot/commit/9ca99c024e26abd869d26a2b2323c34d909156cc))
* **desktop:** keep the session chat usable with the debug panel open on 1280 px windows ([#22](https://github.com/fmilioni/milibot/issues/22)) ([a994c24](https://github.com/fmilioni/milibot/commit/a994c24c8b596d8e0c13875cbbaa58dd1e1b8121))
* **desktop:** keep unsent chat text per conversation across screens and restarts ([#17](https://github.com/fmilioni/milibot/issues/17)) ([5b87e4b](https://github.com/fmilioni/milibot/commit/5b87e4b3324423a008b99ad354bf562e07a47932))
* **desktop:** show each CLI's sign-in status in settings without a manual check ([89bda6c](https://github.com/fmilioni/milibot/commit/89bda6c31a21ffab97a1a8007b5e7942f1d746e8))
* **shared:** redact the lone token of Basic credentials with an empty part ([#36](https://github.com/fmilioni/milibot/issues/36)) ([d3a6cc9](https://github.com/fmilioni/milibot/commit/d3a6cc95933891e51430349c8762ca7277b85410))
* show model calls in the debug panel as they happen, CLI turns included ([#20](https://github.com/fmilioni/milibot/issues/20)) ([69bdd49](https://github.com/fmilioni/milibot/commit/69bdd49ea8035d4872a7c51cbffb8a07b45cb2cb))
* tell someone when the stopped bot is the idle watch's own watcher ([#33](https://github.com/fmilioni/milibot/issues/33)) ([a4a89e7](https://github.com/fmilioni/milibot/commit/a4a89e7c5dd2319211686cbf7ee8bc322d106f73))

## [0.2.2](https://github.com/fmilioni/milibot/compare/v0.2.1...v0.2.2) (2026-10-02)

### Bug Fixes

* **desktop:** stop the packaged app from relaunching itself without end ([#16](https://github.com/fmilioni/milibot/issues/16)) ([67b8c3e](https://github.com/fmilioni/milibot/commit/67b8c3e806cc215de837afa7da968137766c1db6))

## [0.2.1](https://github.com/fmilioni/milibot/compare/v0.2.0...v0.2.1) (2026-10-02)

### Bug Fixes

* **vm:** unpack the bundled QEMU on Windows build machines ([#15](https://github.com/fmilioni/milibot/issues/15)) ([3fd8732](https://github.com/fmilioni/milibot/commit/3fd8732a56c5d19cb8ddb5ae37dfe34430873085))

## [0.2.0](https://github.com/fmilioni/milibot/compare/v0.1.0...v0.2.0) (2026-10-02)

### Features

* **agent:** add Antigravity CLI as a bot engine with plan image generation ([#13](https://github.com/fmilioni/milibot/issues/13)) ([834d26d](https://github.com/fmilioni/milibot/commit/834d26dd2684f021de62a2ab442f77e09376d14f))
* **desktop:** copy text from the VM to the host clipboard ([#3](https://github.com/fmilioni/milibot/issues/3)) ([948631f](https://github.com/fmilioni/milibot/commit/948631f83fb0c6551edee3382a3f58c112002dd5))
* **desktop:** let each workspace choose whether its VM starts on open ([#6](https://github.com/fmilioni/milibot/issues/6)) ([1664435](https://github.com/fmilioni/milibot/commit/1664435bb8b81056a3f997e30399d8cb1b958a10))
* **vm:** ship QEMU with the app and route VM networking through gvproxy ([#14](https://github.com/fmilioni/milibot/issues/14)) ([bb7cc6a](https://github.com/fmilioni/milibot/commit/bb7cc6a0f8d8d64f1ca490263eeb4df450c25eed))

### Bug Fixes

* **desktop:** show the VM state of every workspace in the switcher ([#5](https://github.com/fmilioni/milibot/issues/5)) ([577ecc1](https://github.com/fmilioni/milibot/commit/577ecc1123bf0685d44441eb420507ed811bc0a7))
