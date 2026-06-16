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
 * Derive per-book deltas for the given early `books` (e.g. [1, 2]) from the
 * registry. An entity is *introduced* (a newEntity) in the book of its first
 * appearance; appearances in a later early book become *matched* events there.
 * Aliases/description/type/tags/significance are carried from the registry at
 * introduction (the accepted Phase-1 fidelity caveat).
 *
 * Returns a record keyed by book number.
 */
export function synthesizeEarlyDeltas(registry: Registry, books: number[]): Record<number, RegistryDelta> {
  const bookSet = new Set(books);
  const out: Record<number, RegistryDelta> = {};
  for (const b of books) {
    out[b] = {
      booksProcessed: books.filter((x) => x <= b),
      matched: [],
      newEntities: [],
    };
  }

  for (const e of registry.entities) {
    const earlyAnchors = e.appearances.map(normalizeAnchor).filter((a) => bookSet.has(bookOf(a)));
    if (earlyAnchors.length === 0) continue;

    const introBook = bookOf(normalizeAnchor(e.firstAppearance?.anchor ?? sortAnchors(earlyAnchors)[0]!));
    for (const b of books) {
      const bookAnchors = sortAnchors(earlyAnchors.filter((a) => bookOf(a) === b));
      if (bookAnchors.length === 0) continue;
      if (b === introBook) {
        const intro: RegistryEntity = {
          ...e,
          appearances: bookAnchors,
          firstAppearance: e.firstAppearance
            ? { ...e.firstAppearance, anchor: normalizeAnchor(e.firstAppearance.anchor) }
            : { anchor: bookAnchors[0]!, snippet: "" },
        };
        out[b]!.newEntities.push(intro);
      } else {
        for (const anchor of bookAnchors) out[b]!.matched.push({ id: e.id, anchor, aliases: [] });
      }
    }
  }
  return out;
}
