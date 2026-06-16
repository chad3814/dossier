import { anchorSortKey, cleanAliases, normalizeAnchor, resolveGroup } from "./registry.js";
import type { AliasSupplement, Cutoff, MergeMap, Registry, RegistryDelta, RegistryEntity } from "./types.js";

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

function bookOf(anchor: string): number {
  return anchorSortKey(anchor)[0];
}

function newBookOf(delta: RegistryDelta): number {
  return delta.booksProcessed.length ? Math.max(...delta.booksProcessed) : 0;
}

function firstAnchorOf(ne: RegistryEntity): string | null {
  // Gate the introduction on the EARLIEST appearance, not the firstAppearance field:
  // after dedupe, registry.firstAppearance can be later than a merged member's earliest
  // anchor, and an entity must be introduced before any of its appearances are folded.
  const sorted = ne.appearances
    .map(normalizeAnchor)
    .sort((a, b) => {
      const ka = anchorSortKey(a);
      const kb = anchorSortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    });
  if (sorted.length > 0) return sorted[0] as string;
  return ne.firstAppearance ? normalizeAnchor(ne.firstAppearance.anchor) : null;
}

/**
 * Replay the per-book deltas into a registry, gated to a reading position.
 *
 * Events are folded into raw entities keyed by their delta id, then grouped by
 * the frozen `mergeMap` (id → canonical id) and resolved with `resolveGroup` —
 * the same field logic `dedupe` uses — so a full materialization reproduces the
 * committed registry exactly and gated views stay consistent with it.
 */
export function materialize(
  deltas: RegistryDelta[],
  mergeMap: MergeMap = {},
  options: { upTo?: Cutoff; aliasSupplement?: AliasSupplement } = {},
): Registry {
  const { upTo, aliasSupplement = {} } = options;
  const raw = new Map<string, RegistryEntity>();

  for (const delta of [...deltas].sort((a, b) => newBookOf(a) - newBookOf(b))) {
    for (const ne of delta.newEntities) {
      const first = firstAnchorOf(ne);
      if (!first || !withinCutoff(first, upTo)) continue; // introduced after the cutoff
      const keptAnchors = [...new Set(ne.appearances.map(normalizeAnchor).filter((a) => withinCutoff(a, upTo)))];
      const existing = raw.get(ne.id);
      if (existing) {
        for (const a of keptAnchors) if (!existing.appearances.includes(a)) existing.appearances.push(a);
        existing.aliases.push(...ne.aliases);
      } else {
        raw.set(ne.id, { ...ne, appearances: keptAnchors, aliases: [...ne.aliases] });
      }
    }
    for (const m of delta.matched) {
      const anchor = normalizeAnchor(m.anchor);
      if (!withinCutoff(anchor, upTo)) continue;
      const entity = raw.get(m.id);
      if (!entity) continue; // intro gated out or unknown id — skip defensively
      if (!entity.appearances.includes(anchor)) entity.appearances.push(anchor);
      if (m.aliases.length > 0) entity.aliases.push(...m.aliases);
    }
  }

  // Group by canonical id (frozen map) and resolve with dedupe's logic.
  const groups = new Map<string, RegistryEntity[]>();
  for (const [rawId, entity] of raw) {
    const canonicalId = mergeMap[rawId] ?? rawId;
    const group = groups.get(canonicalId);
    if (group) group.push(entity);
    else groups.set(canonicalId, [entity]);
  }

  const entities: RegistryEntity[] = [];
  for (const [canonicalId, group] of groups) {
    const resolved = resolveGroup(group);
    resolved.id = canonicalId;
    const extra = aliasSupplement[canonicalId];
    if (extra && extra.length > 0) {
      resolved.aliases = cleanAliases(resolved.canonicalName, [...resolved.aliases, ...extra]);
    }
    entities.push(resolved);
  }

  entities.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  // Derived from the books that actually contributed a surviving appearance. This equals
  // the source's booksProcessed as long as every processed book yields ≥1 included anchor
  // (true for the synthesized DCC log); a processed-but-empty book would not appear here.
  const booksProcessed = [...new Set(entities.flatMap((e) => e.appearances).map(bookOf))].sort((a, b) => a - b);
  return { booksProcessed, entities };
}
