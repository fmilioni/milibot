# Changelog

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
