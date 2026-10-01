---
name: design-to-code
description: 'Implementing a canvas design in a codebase. Load it before coding a screen or component from a design: read it, map its tokens and compare the result.'
milibot:
  tools: [design]
---

# From design to code

1. Read the design: `design_read` (themes, tokens, frames), then `design_read` with each frame to implement (its HTML, CSS and a rendered outline with positions and sizes). `design_screenshot` to see it.
2. Export a reference next to the code, outside the source tree (e.g. a scratch folder in the repository's worktree, not committed): `design_export` format html. `<frame>.source.html` is the markup with Tailwind classes and Lucide icons (`data-icon`); `tokens.css` has the tokens as CSS variables (the default theme on `:root`, the others under `[data-theme="<name>"]`) and the same variables as a Tailwind v4 `@theme` block. Drawings (`<img data-art="<name>">` in the source) are `art/<name>.svg`: copy them into the project's assets.
3. Map the tokens before writing components:
   - Tailwind v4: add the variables to the project's `@theme` (or import `tokens.css` after tailwindcss) so the same utilities (`bg-primary`, `rounded-card`) work.
   - Tailwind v3: extend `theme.colors`, `borderRadius`, `fontFamily`… with `var(--color-…)` and define the variables in the global CSS.
   - Plain CSS, CSS-in-JS or a design system: reuse the project's existing variables when a token matches one (same value or role) and add the rest in the project's convention, never a parallel system. Themes go into the project's theme mechanism (class, data attribute, `prefers-color-scheme`).
4. Build with the project's own stack: its framework, components, icon set (Lucide names map to `lucide-react`, `lucide-vue-next`…) and fonts. The design's HTML is a specification, not code to paste: keep semantic elements, labels, alt text, focus states and the responsive behavior the frames do not show.
5. Compare: run the app, open the page with the browser tools at the frame's width and compare it with `design_screenshot` of the frame: spacing, sizes, colors, fonts, alignment, line breaks. Fix what differs.
6. Report what was built, where the tokens live now, and the gaps (states, breakpoints or content the design did not cover) and what you decided for them.
