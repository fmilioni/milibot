---
name: slides
description: 'Presentations as 1920×1080 slides on the canvas, exported to PDF or PowerPoint. Load it together with design before making a deck or slides.'
milibot:
  tools: [design]
---

# Slides

A deck is a design whose frames are slides: load the design skill too and follow it.

## Plan

- Outline first: the audience, the one message, and one idea per slide. Titles state the point ("Revenue doubled in Q3"), not the topic ("Revenue"). Usual shape: title, agenda (only for more than 8 slides), content, summary or next steps.
- Tokens for a deck: background, surface, text, muted, one accent; a display font plus Inter; a large type scale (title 80–96px, slide headline 56–64px, body 28–36px, captions 20px or more). Nothing smaller than 20px.

## Drawing

- One frame per slide, 1920×1080, named after its title ("Revenue doubled"). The frame order is the slide order (`design_frame` reorder).
- Margins of at least 96px; the headline in the same place on every content slide; at most 6 bullets of 12 words; prefer a chart, a big number, a diagram or an image to text.
- Pictures and drawings follow the design skill; full-bleed pictures are 16:9.
- Reuse layouts: `design_frame` duplicate, then `design_edit_frame`.
- Review the rhythm of the deck with `design_screenshot`, 3–4 slides at a time at scale 0.5.

## Export

- PDF (the usual choice): `design_export` format pdf, path `/workspace/…/<deck>.pdf` — one page per slide, in order.
- PowerPoint: `design_export` format png at scale 1 into a folder, write the speaker notes as JSON (`{"01-revenue-doubled": "notes…"}`, keys = the PNG names without extension), then run:
  `uv run --with python-pptx python /usr/local/share/milibot/skills/slides/scripts/build_pptx.py --images <png folder> --out <deck>.pptx [--notes notes.json]`
  Each slide is a full-slide image (16:9) with its notes; the text is not editable in PowerPoint. Tell the user, and offer the PDF or the canvas for changes.
- Deliver the file with share_file (the user gets a download button), unless they asked for it somewhere else.
