import { anchorSortKey, normalizeAnchor } from "./registry.js";
import type { Cutoff } from "./types.js";

/**
 * Is `anchor` at or before the reading-position `cutoff`?
 * A chapter cutoff ("B2·C4") includes the whole chapter; a paragraph cutoff
 * ("B2·C4·¶7") is inclusive at that paragraph. No cutoff ⇒ always true.
 */
export function withinCutoff(anchor: string, cutoff?: Cutoff): boolean {
  if (!cutoff) return true;
  const a = anchorSortKey(normalizeAnchor(anchor));
  const k = anchorSortKey(normalizeAnchor(cutoff));
  const cutoffPara = cutoff.includes("¶") ? k[2] : Number.POSITIVE_INFINITY;
  if (a[0] !== k[0]) return a[0] < k[0];
  if (a[1] !== k[1]) return a[1] < k[1];
  return a[2] <= cutoffPara;
}
