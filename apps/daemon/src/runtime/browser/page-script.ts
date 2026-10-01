/**
 * Script evaluated in the page (main world) through CDP `Runtime.evaluate`. It installs a small helper
 * under `Symbol.for('milibot.browser')` that keeps element refs (`e<N>`) for the life of the document and
 * returns compact trees for the daemon to format (`snapshot.ts`). The source is `scripts/page.js` (ES5, kept as
 * text: tsx/esbuild may inject helpers into `Function#toString()` output).
 *
 * Tree nodes: a string is text; an object is `{r, n?, ref?, lv?, st?, v?, h?, b?, i?, x?, ch?, ph?, d?, c?}`
 * (role, name, ref, heading level, states, value, href, block, inline, cross-origin frame, chips of a
 * recipient-like field, placeholder, description/hint, children). Generic elements have `r: ''`.
 * Open dialogs and alerts come first in the tree, with the rest of the page after them.
 */
import { sha256 } from '../../util/hash'
import { PAGE_SCRIPT } from './scripts/page.generated'

/** A page keeps the helper it got until it reloads; a new daemon version replaces it (refs survive). */
const INSTALL = PAGE_SCRIPT.trimEnd().replace('@VERSION@', sha256(PAGE_SCRIPT).slice(0, 12))

/** Expression that installs the helper (if needed) and calls `method` with JSON-serializable args. */
export function pageCall(method: string, ...args: unknown[]): string {
  return `${INSTALL}.${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`
}
