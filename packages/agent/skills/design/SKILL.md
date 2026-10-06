---
name: design
description: 'Screens, pages, mockups, logos and illustrations drawn on the canvas with the design tools. Load it before creating or changing any design, frame or drawing.'
milibot:
  tools: [design]
---

# Designing on the canvas

A design is a canvas of frames the user watches live in the app (they can drag frames around and change token values, nothing else). You write each frame as an HTML fragment styled with Tailwind v4 classes and the design's tokens; photos and imagery come from `generate_image`, and logos and flat marks are drawn for you in the background (`design_draw`).

## Pick a guide first

Read the guide for what you are making with `skill_read` (name "design", path below) before the first frame. Decks and printed documents have skills of their own that go with this one: `slides` and `documents-pdf`.

| Making                                      | Guide                       |
| ------------------------------------------- | --------------------------- |
| Landing page, website, marketing page, blog | `guides/landing-page.md`    |
| Web app, dashboard, admin, SaaS screen      | `guides/web-app.md`         |
| Phone app screens                           | `guides/mobile-app.md`      |
| Tables, lists of records, charts, KPIs      | `guides/data-and-tables.md` |
| Logo, brand mark, flat mascot or pictogram  | `guides/artwork.md`         |

## Workflow

1. Brief, then a direction: what the frames are for, which frames exist, the palette, the type pair, the corner radius, the spacing scale and one idea that makes this design memorable. Ask only when the brief lacks something that changes the design.
2. `design_create` with the themes and tokens. Theme names in the user's language ("Light", "Dark"); the first one is the default.
3. Frames one at a time. Read the problems in each `design_write_frame` result and fix them before starting the next frame.
4. Fix in place with `design_edit_frame` (exact text replacement, copied from `design_read`). Never delete a frame to redo it for a detail.
5. `design_screenshot` every 2 to 4 frames and at the end, and look at it critically: alignment, spacing rhythm, contrast, hierarchy, awkward line breaks, anything clipped. Not after every edit.
6. Tell the user in a line or two what you drew; the design card in the chat opens the canvas.
   Elsewhere (cards, plans, other chats) a design or frame is pointed at by its raw id (`dsg_…`, `dfr_…`), which the app shows as a link to the canvas.

## Comments on an element

The user can point at an element on the canvas and comment on it. The message then starts with its reference, then the comment:

```
[Element <button> "Save" in frame "Checkout" (dfr_…) of the design "Shop" (dsg_…)]
Selector: body > main:nth-child(1) > form:nth-child(2) > button:nth-child(3)
Source: <button class="btn-primary w-full">
make it smaller
```

- `Source` is the element's opening tag exactly as written in the frame's HTML and unique there (sometimes the whole element): use it as `old_text` in `design_edit_frame`, keeping or changing its attributes in `new_text`. To change what is inside the element, `design_read` the frame and take a longer `old_text` starting at it.
- `Source (occurrence 2 of 3)` means the same text appears more than once: `design_read` and include the text around it. `Source, as a JSON string` holds line breaks: decode it before using it as `old_text`. Without `Source`, find the element by its `Selector`, a path of element positions in the frame's HTML (icons are `<i data-icon>`, drawings `<div data-art>` there).
- Change only that element (and what the comment asks around it), then answer in a line what you changed.

## Frames

- A frame is a whole page or a whole screen, never a section of one. A web page (landing page, site page, article) is **one** frame 1440 wide with no height: it grows with its content, however long. Asked for "a landing page", you draw one frame. Its mobile version is another frame, 390 wide, no height.
- A fixed height only where the frame is a viewport or a sheet: app screens (desktop 1440×900, mobile 390×844), slides (1920×1080), printed pages (A4 794×1123). A screen whose content runs past its height grows by itself (the result says so); make it fit instead only when the screen must stay one viewport (inner scrolling area with `overflow-auto`). Slides and pages never grow: split or cut.
- Name every frame for what it shows ("Home — desktop", "Checkout — mobile"). The frame order is the page or slide order (`design_frame` reorder).
- Frames are placed side by side automatically; pass x/y only to group related frames (one row per flow). A frame never goes on top of another.
- The HTML is the body's content: no `<html>`/`<head>`, no scripts (they are removed), no hover or animation (it is a still). The frame is the viewport: full-bleed backgrounds use `min-h-full` on the root element.

## Layout in HTML and Tailwind

- Structure with `flex` and `grid` plus `gap-*`. No spacer divs, no margins to space siblings, no `absolute` except real overlays (badges, a caption over an image, a floating button).
- Elements size to their content by default; to fill, `flex-1`, `w-full` or `self-stretch`; fixed sizes only for boxes that really are fixed (avatars, icons, media, a sidebar width).
- Text never gets a fixed height. Limit its width instead (`max-w-[60ch]`); `truncate` or `line-clamp-*` only where cutting is the design.
- A parent that sizes to its children while every child fills the parent has no size: give one of them a real width or let it hug.
- Equal cards: `grid grid-cols-3 gap-6` (plus `auto-rows-fr` for equal heights), never matched pixel heights.
- Offset one child with padding on a wrapper, not a margin on the child.
- Repeated components are the same markup everywhere (copy it); `data-id` on key elements makes the outlines easier to follow.
- Spacing from one scale (multiples of 4 or 8): 24 to 32 between sections of a screen, 16 to 24 inside card grids, 16 between form fields, 12 between buttons, 24 inside cards.

## Tokens

- A small, complete set: background, surface, text, muted text, border, primary and its text, one accent, success/warning/danger when needed; one or two font families; a radius; a few font sizes and spacing steps. Colors get a value per theme; sizes one value for all.
- Token names are CSS variables that are also Tailwind utilities: color `primary` → `--color-primary`, `bg-primary`, `text-primary`, `border-primary`, `bg-primary/10`; `radius-card` → `rounded-card`; `text-hero` → `text-hero`; `font-display` → `font-display`; `spacing-gutter` → `p-gutter`, `gap-gutter`. In CSS: `var(--color-primary)`.
- Use tokens instead of raw values so themes and later changes apply everywhere; Tailwind's own palette and arbitrary values (`w-[312px]`) are for one-offs. Colors carry meaning: danger only for errors and destructive actions, the accent for what the user should do.
- A frame shows one theme (`design_frame` set_theme); `design_screenshot` with `theme` previews another. Design the default theme first, then check the others.
- Fonts: Inter is the default. For another family, list it (Google Fonts) in `fonts` and point a font token at it (`font-display: "Fraunces", serif`). Milibot embeds them: the fonts on your machine do not matter.
- The user may change token values in the canvas: `design_read` lists their changes; build on them.

## Icons, images, shapes and drawings

Take the cheapest thing that works:

1. **Icons**: always Lucide, `<i data-icon="lucide:arrow-right" class="size-5 text-muted"></i>`. `size-*` sets the size, the color is the text color. An unknown name shows a dashed box and a problem. Never draw an icon.
2. **Photos and imagery** (people, faces, scenes, places, products, food, textures, hero and section backgrounds, anything that should look like a photo, a render or a painting): `generate_image` with `share: false`, then `src="/workspace/images/…"` (copied into the design). Plan every picture of the page first and generate them in **one call** (up to 4), with the aspect of the slot each one fills and prompts that carry the design's palette and mood; then write the frame. A file the user gave you in `/workspace` or a real https URL works the same way. Without `generate_image` (no image model set up) and no file: a gradient, shapes or a neutral block, never a drawing of a person or a scene. No placeholder-image services.
3. **Simple geometry** (dividers, blobs, glows, badges, patterns, bar charts): HTML and CSS, or a small inline `<svg>` in the frame.
4. **`design_draw`**: only for art that is vector by nature: a logo or brand mark, a flat mascot, a pictogram, a decorative pattern, or a flat illustration the user explicitly asked for. Never people, faces, realistic scenes, products or backgrounds (those are pictures, item 2), unless the user asks for a flat vector illustration of them. Never draw logos or illustrations by hand in inline SVG: they come out crude.

Drawing rules:

- It runs in the background (a few minutes). Keep designing and place it right away with `<img data-art="Logo" alt="Acme" class="h-10 w-auto">`: a placeholder of its shape shows until it is ready, then every frame placing it updates by itself.
- One drawing per subject, reused everywhere with `data-art`. Never one per frame, section or card, and never several variants.
- To change a finished drawing, draw it again with the same name and a brief that says only what changes, concretely (what, where, size, color): the drawer starts from the current drawing and keeps the rest.
- Never wait for it: no `sleep`, no polling, no screenshots of it. Keep designing, or end your reply telling the user it is still being drawn (they watch it appear on the canvas). A later design tool result tells you when it finished, and `design_read` shows `drawing`, `ready` or `failed`. If it failed, draw it again once (same name), with a simpler brief when the reason says so.
- The drawer sees nothing of the design, so the brief carries everything. Read `guides/artwork.md` before the first drawing of a design: how to write the brief, with examples, and the sizes. Words and brand names go in the HTML next to the art, not inside it.

## Avoid the generic AI look

- Don't wrap everything in cards: a container needs a structural reason.
- No purple-to-blue gradient by default, no shadows, glass or rounded corners everywhere, no emoji as icons, no centered hero plus three cards by reflex.
- One dominant region per screen; the accent color reserved for the primary actions; one primary action per section.
- At least one distinctive move per design: an unexpected type pairing, an asymmetric layout, a bold color field, a custom drawing.
- Real content in the user's language: plausible names, numbers and copy, never lorem ipsum.

## Quality checklist

- One focal point per frame; hierarchy through size and weight, not only color.
- A consistent spacing scale, aligned edges, generous outer margins; nothing touching the frame edge by accident.
- Body text contrast of at least 4.5:1 in every theme; text over images gets an overlay.
- Paragraphs of 45 to 80 characters per line, line height around 1.5; at most two font families and about five text sizes.
- Every problem in the last tool result fixed, or intended.

## Tool reference

Designs and frames are named by name or id.

- `design_create {name, themes?, tokens?, fonts?}`: `themes` in order, the first is the default (["Light", "Night"]); `fonts` are Google Fonts families to embed. The design shows up as a card in this chat.
- Token items (`design_create`, `design_set_tokens`): `{name, type?, value? | values?, delete?}`. `name` is the CSS variable without `--` (`color-primary`, `radius-card`, `text-hero`, `font-display`, `spacing-gutter`); `type` is color, number, string or font; `value` is the same in every theme (a bare number is px); `values` is per theme (`{"Light": "#fff", "Night": "#0b0b0f"}`); `delete: true` removes it.
- `design_set_tokens {design, themes?, rename_themes?, tokens?, fonts?}`: tokens merge by name (send only what changes); `themes` and `fonts` are the whole new lists; `rename_themes` is `{old: new}`.
- `design_read {design, frame?}`: themes, tokens per theme, fonts, frames (size, position, theme or drawing state) and the user's recent changes; with `frame`, its HTML and CSS plus an outline of the rendered elements (a drawing: its brief and state).
- `design_write_frame {design, name, width, html, frame?, height?, theme?, css?, x?, y?}`: creates a frame, or replaces `frame` (a new name there creates one). `html` is the body content; `css` is extra CSS (`@apply` works); `height` omitted or 0 grows with the content; `theme` defaults to the first; without x/y a new frame goes next to the others. Write `html` last: the canvas draws the frame while you write it, at the size you gave before. Returns layout problems and an outline, not an image.
- `design_edit_frame {design, frame, edits: [{old_text, new_text}]}`: exact replacements over the HTML and CSS; each `old_text` must match exactly once; all edits apply or none.
- `generate_image` (see its own description): pictures for the design go with `share: false` and are used by their `/workspace/images/…` path.
- `design_draw {design, name, prompt, width, height, x?, y?}`: starts drawing vector art into an art frame of that size (a new one, or the art frame with that name, redrawn) and returns at once. `prompt` is the brief (20 to 2000 characters); sides 32 to 2048. Place it in frames with `<img data-art="<name>">` (any classes, alt, width or height). An art frame can't be written or edited, only redrawn, moved, resized, renamed (its `data-art` references follow) or deleted (which stops its drawing). At most 3 drawings of yours in progress at once.
- `design_frame {design, frame, action}`: `move` (x, y; refused on top of another frame), `resize` (width, height; 0 = grow), `rename` (name), `duplicate`, `delete`, `set_theme` (theme), `reorder` (position, 0 = first page or slide).
- `design_screenshot {design, frames, theme?, scale?}`: up to 4 frames as images with their problems; `theme` renders them in another theme; `scale` 0.25 to 2 (default 1).
- `design_export {design, format, path, frames?, scale?}`: png (one file per frame), pdf (one page per frame) or html (a standalone page, the source HTML and `tokens.css`, and every drawing as `art/<name>.svg`, for whoever implements it: design-to-code skill). `frames` default to all, in order; `path` is a folder, or a `.pdf` file, or a `.png` for one frame, under /workspace; `scale` is the PNG scale 0.5 to 3 (default 2). Deliver a file to the user with share_file.
- `design_list {archived?}`: active designs; `archived: true` lists the archived ones too (old work to reuse or look back at).
- `design_archive {design, archived?}`: archives a design (`archived: false` unarchives it) so it leaves the list; an archived one is read by id or exact name and must be unarchived before any change. Archive when the user asks or a finished design is no longer worked on.
- `design_delete {design}`: deletes the design with every frame and its version history, for good. Only when the user asks for it; to drop one frame use `design_frame` delete.
