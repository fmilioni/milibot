# Tables, lists and charts

## Tables

- A real `<table>` or rows of `grid` with the same column template; every cell in a column has the same width.
- Column widths by content: names 200 to 250 px, status 100 to 120, dates 120 to 150, amounts and actions 80 to 100, the free text column takes the rest.
- Numbers right-aligned with `tabular-nums`, text left-aligned; the header in muted small text; 40 to 48 px rows.
- Zebra stripes or row dividers, not both. Status as small colored badges, not colored text alone.
- A toolbar above (search, filters, the primary action on the right) and pagination or a count below.
- Plausible data, 6 to 12 rows, varied lengths; an empty table gets its empty state (what goes here and how to add the first item).
- 4 to 7 columns on desktop; on a phone the table becomes a list of cards.

## Charts

- Draw them in HTML/CSS (bars as divs with heights) or a small inline `<svg>` with plausible data.
- Bars for comparing, lines for time, a single big number for one value; avoid pies with more than 4 slices.
- Axis labels and a legend in muted small text; highlight the one series or point that matters in the accent color, the rest muted.
- Every chart has a title stating what it shows and, when possible, the takeaway ("Revenue up 32% since June").

## KPI tiles

- A label, a big number, the change with its direction and period ("+12% vs last month"); 3 to 4 per row, same size.
