import { type Box, type ElementShot, union } from './bot-cursor'
import { hashString } from './canvas'

/** How long a changed element stays outlined; equals the `.canvas-change-flash` animation in styles.css. */
export const CHANGE_FLASH_MS = 1000
/** More changed elements than this get one outline around all of them (a frame rewritten from scratch). */
export const MAX_FLASH_BOXES = 40

interface Tree {
  children: number[][]
  /** Hash of each element with everything inside it. */
  subtree: string[]
  /** Elements in each subtree, itself included. */
  size: number[]
}

function treeOf(shots: readonly ElementShot[]): Tree {
  const children: number[][] = shots.map(() => [])
  for (const [i, shot] of shots.entries()) if (shot.parent >= 0) children[shot.parent]?.push(i)
  const subtree: string[] = Array.from({ length: shots.length }, () => '')
  const size: number[] = Array.from({ length: shots.length }, () => 1)
  // Children always come after their parent in document order.
  for (let i = shots.length - 1; i >= 0; i--) {
    const kids = children[i] as number[]
    for (const k of kids) size[i] = (size[i] as number) + (size[k] as number)
    subtree[i] =
      `${hashString(`${shots[i]?.signature}[${kids.map((k) => subtree[k]).join(',')}]`)}:${size[i]}`
  }
  return { children, subtree, size }
}

function counts(keys: Iterable<string>): Map<string, number> {
  const map = new Map<string, number>()
  for (const key of keys) map.set(key, (map.get(key) ?? 0) + 1)
  return map
}

const take = (map: Map<string, number>, key: string): boolean => {
  const n = map.get(key) ?? 0
  if (n <= 0) return false
  map.set(key, n - 1)
  return true
}

/** Which elements of `after` are new or changed their own tag, attributes or text since `before`. */
function changedFlags(before: readonly ElementShot[], after: readonly ElementShot[], tree: Tree): boolean[] {
  const leftSubtrees = counts(treeOf(before).subtree)
  const leftOwn = counts(before.map((s) => s.signature))
  const unchanged: boolean[] = after.map(() => false)
  const markSubtree = (i: number) => {
    unchanged[i] = true
    take(leftSubtrees, tree.subtree[i] as string)
    take(leftOwn, (after[i] as ElementShot).signature)
    for (const k of tree.children[i] as number[]) markSubtree(k)
  }
  // Whole subtrees that existed before are untouched (moved or shifted at most). Bigger ones first, so a
  // repeated element nested in one isn't taken by a lone copy elsewhere.
  const bySize = after.map((_, i) => i).sort((a, b) => (tree.size[b] as number) - (tree.size[a] as number))
  for (const i of bySize)
    if (!unchanged[i] && (leftSubtrees.get(tree.subtree[i] as string) ?? 0) > 0) markSubtree(i)
  // What is left keeps its place when its own content is the same (a container whose child changed).
  for (const [i, shot] of after.entries())
    if (!unchanged[i] && take(leftOwn, shot.signature)) unchanged[i] = true
  return unchanged.map((u) => !u)
}

/**
 * The boxes to outline when a page goes from `before` to `after`, in frame pixels. An element that is new
 * with everything inside it is outlined as a whole (a new button with its icon); otherwise only the deepest
 * changed elements are (a container whose own classes and a child changed outlines just the child).
 * Invisible elements are skipped; past `MAX_FLASH_BOXES` one box surrounds them all.
 */
export function changedElements(before: readonly ElementShot[], after: readonly ElementShot[]): Box[] {
  const tree = treeOf(after)
  const changed = changedFlags(before, after, tree)
  const changedInside: boolean[] = after.map(() => false)
  const allNew: boolean[] = changed.slice()
  for (let i = after.length - 1; i >= 0; i--) {
    const parent = (after[i] as ElementShot).parent
    if (parent < 0) continue
    if (changed[i] || changedInside[i]) changedInside[parent] = true
    if (!allNew[i]) allNew[parent] = false
  }
  const boxes: Box[] = []
  for (const [i, shot] of after.entries()) {
    if (!changed[i]) continue
    const root = allNew[i] && !(shot.parent >= 0 && allNew[shot.parent])
    const deepest = !allNew[i] && !changedInside[i]
    if ((root || deepest) && shot.box.width > 0 && shot.box.height > 0) boxes.push(shot.box)
  }
  if (boxes.length <= MAX_FLASH_BOXES) return boxes
  const all = union(boxes)
  return all ? [all] : []
}

interface Shown {
  look: string
  shots: ElementShot[]
}

const MAX_REMEMBERED = 200
/**
 * The last page loaded per frame. Lives outside the components: a frame's iframe unmounts while a draft
 * stands in for it, off screen and below the render size, and must compare with what was shown before.
 */
const shownPages = new Map<string, Shown>()

/**
 * Records the page a frame just loaded and returns what to outline: nothing the first time, after a change
 * of look (`look`: the theme and its values restyle everything) or when the content is the same.
 */
export function pageChanged(frameId: string, look: string, shots: ElementShot[]): Box[] {
  const previous = shownPages.get(frameId)
  shownPages.delete(frameId)
  shownPages.set(frameId, { look, shots })
  if (shownPages.size > MAX_REMEMBERED) shownPages.delete(shownPages.keys().next().value as string)
  if (!previous || previous.look !== look) return []
  return changedElements(previous.shots, shots)
}

/** The page last recorded for a frame. */
export function shownPage(frameId: string): ElementShot[] | null {
  return shownPages.get(frameId)?.shots ?? null
}

/** Test helper: forget every recorded page. */
export function forgetShownPages(): void {
  shownPages.clear()
}
