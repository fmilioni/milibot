---
name: documents-pdf
description: 'Designed documents as A4 pages on the canvas, exported to PDF: reports, proposals, one-pagers, CVs, flyers. Load it together with design before making one.'
milibot:
  tools: [design]
---

# Documents as PDF

A document is a design whose frames are pages: load the design skill too and follow it (this skill is its guide for printed pages).

## Pages

- One frame per page: A4 794×1123 (portrait) or 1123×794 (landscape), US Letter 816×1056. Name them in order ("Page 1", "Page 2"… in the user's language); the frame order is the page order (`design_frame` reorder).
- Pages never grow and content does not flow between them by itself: split it yourself, and check every page for text cut off at the bottom (the problems list reports it). Never let a heading end a page.
- Margins of 64–80px, the same on every page. A header or footer with the document name and the page number written in, the same markup and position on every page (copy it), except the cover.

## Typography and color

- Body 15–16px with line height 1.5–1.6 and 60–75 characters per line; headings in 3–4 sizes with clear steps, from the same family or one contrasting family; a serif or a neutral sans for long text (Inter is the default).
- Tokens for text, muted text, rule/border color, one accent; tables with light rules, aligned numbers (`tabular-nums`, right-aligned) and repeated header rows on each page.
- Print-friendly: light backgrounds, enough contrast in grayscale, no dark full-page fills unless it is a cover, and never color alone to carry meaning.
- CVs and one-pagers: a clear top block (name, role, contact), sections in a strict grid, no decorative clutter.

## Export

- Check a couple of pages with `design_screenshot`, then `design_export` format pdf, path `/workspace/…/<name>.pdf`: one page per frame, in order, at the frame's size.
- Deliver it with share_file (the user gets a download button), unless they asked for it somewhere else.
