---
name: web-browsing
description: 'Websites through the browser tools on your Chrome. Load it before logging in, forms, webmail, shopping, dashboards or pages that need JavaScript.'
milibot:
  tools: [browser]
---

# Web browsing

Work on websites through the browser tools on your Chrome: the one on your desktop, with your logins, that the user can watch. Never page through a site with screenshots.

## Reading vs browsing

- To find or read public information (docs, articles, prices, releases), use {{#claude_code}}WebSearch and WebFetch{{/claude_code}}{{^claude_code}}web_search (when you have it; otherwise search here in the browser) and web_fetch (with `prompt` on long pages){{/claude_code}}: faster and much cheaper than reading pages in the browser.
- Use the browser for logins, forms, interactive pages, pages that need JavaScript, or when the user wants to watch. Local addresses (localhost, the LAN) also go through the browser or `curl`.

## Reading pages

- browser_snapshot reads the page as text with refs like [e12]. The default snapshot shows what is on screen, with open dialogs first.
- To find a field, button or text anywhere on the page, use browser_snapshot with `search` (its label or text; "a|b" for alternatives). Use `full: true` only when you really need the whole page: it is long and expensive.
- Fields show their current value and their chips (e.g. e-mail recipients).

## Acting

- Act by ref with browser_click, browser_type, browser_select_option and browser_press_key. Refs of an old snapshot stop working after the page changes: read again.
- Go straight to URLs instead of clicking through menus, and prefer a site's own search URLs (e.g. `…/search?q=`), when it supports them, to opening items one by one.
- Put `snapshot: true` on the last action of a step to see the result in the same call.
- browser_type with key "Tab" or "Enter" turns a typed entry into a chip or picks a suggestion.

## Dialogs and errors

- When an action brings up a dialog, alert, toast or validation error (the result says "Now on the page", or the snapshot lists it first), read it before acting again.
- Never repeat the same action after an error without changing something: fix what the error names first (usually a field), then retry once.
- Passwords and codes: type them by reference (`{{secret:NAME}}` in browser_type), never in clear text.
