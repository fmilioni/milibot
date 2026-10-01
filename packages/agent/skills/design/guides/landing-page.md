# Landing pages and websites

## Frames

- One frame per page: 1440 wide, no height (it grows). The whole page, top to bottom, is that frame; sections are parts of it, never frames of their own.
- A mobile version is a second frame, 390 wide, no height, with the same sections restacked in one column.
- Other pages of the same site (pricing, about, a blog post) are frames of their own, same width.

## Story

- A landing page sells one thing and asks for one action. Write the copy before the layout: the promise, the proof, the action.
- Hero: the whole pitch compressed into a headline, one supporting line and one call to action (a secondary link at most). Headlines that state the outcome for the reader beat feature lists ("Close the month in a day", not "Accounting software").
- Then the proof and the details, in an order that answers the reader's doubts: how it works, what it does for them, who already uses it (logos, numbers, a quote with a name and a face), what it costs, answers to objections (FAQ), and the call to action again at the end.
- The navigation is short (4 to 6 items) with the call to action on the right.

## Layout

- Sections of 96 to 160 px of vertical padding, content within a max width of 1120 to 1280 px, centered in the frame, same side margins everywhere.
- Alternate the rhythm: a text-heavy section, then a visual one; a light band, then a dark or tinted one for emphasis (credibility, the final call to action).
- One alignment per section: either centered or left-aligned, never both. Don't center more than two or three lines of text.
- Body text 16 to 18 px, never under 14; lines of 50 to 75 characters.
- The hero needs a visual: a picture from `generate_image` (people using the product, the result, the place) or a product mockup built in HTML; a flat drawing (`design_draw`) only when the brand's style is flat illustration. Show people or the result, not an empty gradient.
- Generate the page's pictures (hero, feature shots, testimonial portraits, a background band) together in one `generate_image` call before writing the frame, each with the aspect of its slot and the palette of the tokens.
- Text over a photo always gets a contrast treatment: an overlay, a scrim or its own panel.
- The accent color is for calls to action only, never for decoration.

## Footer

Columns of links, the brand mark, a line with the legal text; smaller and quieter than the rest.
