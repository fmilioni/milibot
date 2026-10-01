# Web apps and dashboards

## Frames

- One frame per screen, 1440×900 (a long screen grows by itself). Name it for the screen and its state ("Invoices — empty").
- States are frames of their own when they matter: empty, loading (skeleton), error, a filled form with validation messages, a success confirmation. Surfaces that show data should not fail silently.
- Flows go in rows with x/y (one row per flow, left to right).

## Structure

- Every screen answers one main question and has one primary action. Competing goals belong on separate screens.
- One dominant region; the rest supports it. Avoid layouts where every block weighs the same.
- The app shell stays identical on every screen: a sidebar of 240 to 280 px or a top bar, then the content with the same padding (24 to 32 px).
- Infer the kind of product from the brief: don't add a sidebar, a table or KPI cards unless the job calls for them.
- Up to two structural zones before adding a third; separate them with space rather than lines.
- If an element helps nobody navigate, understand, decide or act, remove it.

## Details

- One density per screen (compact, regular or airy), usually a 14 px base in apps.
- Anything representing a record (a customer, an invoice, a task) shows its name prominently, its status, its key facts and the obvious actions.
- Icons never replace a label the user needs; icon-only buttons only for universal actions (close, more, search).
- Buttons by weight: one primary per section, then secondary, outline, ghost; destructive ones in the danger color. In dialogs and forms the actions sit bottom right; with Cancel and a destructive action, Cancel comes first.
- Forms: labels above fields, one column, helpful placeholders never replacing labels, errors under the field in the danger color.
- Tables and charts: see `guides/data-and-tables.md`.
