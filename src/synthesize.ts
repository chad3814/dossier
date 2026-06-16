import { anchorSortKey, mergeKey, normalizeAnchor, normalizeName } from "./registry.js";
import type { AliasSupplement, MergeMap, Registry, RegistryDelta, RegistryEntity } from "./types.js";

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

/**
 * Build the frozen merge-map: every dangling *newEntity* id in `rawDeltas`
 * (introduced but absent from the registry — a dedupe collision) maps to the
 * canonical registry entity sharing its mergeKey. A matched-only dangling id
 * (never introduced) is left unmapped — it is dropped at fold time exactly as
 * applyDelta drops unknown matched ids. Throws only if a dangling newEntity id
 * cannot be resolved.
 */
export function buildMergeMap(registry: Registry, rawDeltas: RegistryDelta[]): MergeMap {
  const registryIds = new Set(registry.entities.map((e) => e.id));
  const canonicalByKey = new Map<string, string>();
  for (const e of registry.entities) {
    const key = mergeKey(e.canonicalName);
    if (!canonicalByKey.has(key)) canonicalByKey.set(key, e.id);
  }

  // Names for dangling ids come from their newEntity introductions.
  const nameById = new Map<string, string>();
  for (const d of rawDeltas) for (const ne of d.newEntities) nameById.set(ne.id, ne.canonicalName);

  const map: MergeMap = {};
  for (const d of rawDeltas) {
    const ids = [...d.newEntities.map((e) => e.id), ...d.matched.map((m) => m.id)];
    for (const id of ids) {
      if (registryIds.has(id) || map[id] !== undefined) continue;
      const name = nameById.get(id);
      // Matched-only dangling id (never introduced): drop it, like applyDelta does.
      if (!name) continue;
      const canonical = canonicalByKey.get(mergeKey(name));
      if (!canonical) {
        throw new Error(
          `buildMergeMap: cannot resolve dangling newEntity id "${id}" (name: ${name}) to a registry entity`,
        );
      }
      map[id] = canonical;
    }
  }
  return map;
}

/**
 * Capture aliases present in the registry but not produced by folding the deltas
 * (e.g. residue from a series-specific post-pass). Keyed by canonical id.
 */
export function buildAliasSupplement(
  registry: Registry,
  rawDeltas: RegistryDelta[],
  mergeMap: MergeMap,
): AliasSupplement {
  const provided = new Map<string, Set<string>>(); // canonical id -> normalized aliases the deltas yield
  const add = (id: string, name: string): void => {
    const cid = mergeMap[id] ?? id;
    const set = provided.get(cid) ?? new Set<string>();
    set.add(normalizeName(name));
    provided.set(cid, set);
  };
  for (const d of rawDeltas) {
    for (const ne of d.newEntities) {
      add(ne.id, ne.canonicalName);
      for (const a of ne.aliases) add(ne.id, a);
    }
    for (const m of d.matched) for (const a of m.aliases) add(m.id, a);
  }

  const supplement: AliasSupplement = {};
  for (const e of registry.entities) {
    const have = provided.get(e.id);
    // Skip entities that never appear in the raw deltas (their data is synthesized from the registry verbatim).
    if (!have) continue;
    const missing = e.aliases.filter(
      (a) => !have.has(normalizeName(a)) && normalizeName(a) !== normalizeName(e.canonicalName),
    );
    if (missing.length > 0) supplement[e.id] = missing;
  }
  return supplement;
}
