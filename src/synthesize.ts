import { anchorSortKey, normalizeAnchor } from "./registry.js";
import type { Registry, RegistryDelta, RegistryEntity } from "./types.js";

function bookOf(anchor: string): number {
  return anchorSortKey(normalizeAnchor(anchor))[0];
}

function sortAnchors(anchors: string[]): string[] {
  return [...anchors].sort((a, b) => {
    const ka = anchorSortKey(a);
    const kb = anchorSortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

/**
 * Derive the complete position-gated event log from the registry: one delta per
 * book. Each entity is introduced (a newEntity carrying its full registry
 * metadata) in the book of its first appearance, with that book's anchors;
 * appearances in any other book become matched events there.
 *
 * registry.json is the source of truth; this log is derived from it, and
 * `materialize(synthesizeLog(registry))` reproduces it exactly. (Phase 1 carries
 * aliases/description at introduction — the accepted coarse-gating caveat for
 * those fields; appearances gate precisely.)
 *
 * Returns the per-book deltas in book order.
 */
export function synthesizeLog(registry: Registry): RegistryDelta[] {
  const byBook = new Map<number, RegistryDelta>();
  const ensure = (b: number): RegistryDelta => {
    let d = byBook.get(b);
    if (!d) {
      d = { booksProcessed: [b], matched: [], newEntities: [] };
      byBook.set(b, d);
    }
    return d;
  };

  for (const e of registry.entities) {
    const anchors = e.appearances.map(normalizeAnchor);
    if (anchors.length === 0) continue;
    // Introduce at the EARLIEST appearance's book — registry.firstAppearance is the
    // (post-dedupe) primary's first sighting and can be later than a merged member's
    // earliest anchor, so it is not a reliable introduction point.
    const earliest = sortAnchors(anchors)[0] as string;
    const introBook = bookOf(earliest);

    const byBookAnchors = new Map<number, string[]>();
    for (const a of anchors) {
      const b = bookOf(a);
      const list = byBookAnchors.get(b);
      if (list) list.push(a);
      else byBookAnchors.set(b, [a]);
    }

    for (const [b, bAnchors] of byBookAnchors) {
      const sorted = sortAnchors(bAnchors);
      if (b === introBook) {
        const intro: RegistryEntity = {
          ...e,
          appearances: sorted,
          firstAppearance: e.firstAppearance
            ? { ...e.firstAppearance, anchor: normalizeAnchor(e.firstAppearance.anchor) }
            : { anchor: sorted[0] as string, snippet: "" },
        };
        ensure(b).newEntities.push(intro);
      } else {
        const d = ensure(b);
        for (const a of sorted) d.matched.push({ id: e.id, anchor: a, aliases: [] });
      }
    }
  }

  return [...byBook.keys()].sort((a, b) => a - b).map((b) => byBook.get(b) as RegistryDelta);
}
