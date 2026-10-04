import { anchorSortKey, cleanAliases, normalizeAnchor, resolveGroup, type SectionOrder } from "./registry.js";
import type { AliasEvent, AliasSupplement, Cutoff, DescriptionEvent, MergeMap, Registry, RegistryDelta, RegistryEntity } from "./types.js";

/**
 * Total order over anchors by [book, section, paragraph]. Pass the registry's spine `order`
 * whenever it is known; without it, section position falls back to the label heuristic, which
 * cannot order two non-standard labels in one book (e.g. `Synchronism` vs `Synchronism-2`).
 */
function cmpAnchor(a: string, b: string, order?: SectionOrder): number {
  const ka = anchorSortKey(a, order);
  const kb = anchorSortKey(b, order);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
}

/**
 * Is `anchor` at or before the reading-position `cutoff`?
 * A chapter cutoff ("B2·C4") includes the whole chapter; a paragraph cutoff
 * ("B2·C4·¶7") is inclusive at that paragraph. No cutoff ⇒ always true.
 */
export function withinCutoff(anchor: string, cutoff?: Cutoff, order?: SectionOrder): boolean {
  if (!cutoff) return true;
  const a = anchorSortKey(normalizeAnchor(anchor), order);
  const k = anchorSortKey(normalizeAnchor(cutoff), order);
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

function firstAnchorOf(ne: RegistryEntity, order?: SectionOrder): string | null {
  // Gate the introduction on the EARLIEST appearance, not the firstAppearance field:
  // after dedupe, registry.firstAppearance can be later than a merged member's earliest
  // anchor, and an entity must be introduced before any of its appearances are folded.
  const sorted = ne.appearances.map(normalizeAnchor).sort((a, b) => cmpAnchor(a, b, order));
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
  options: {
    upTo?: Cutoff;
    aliasSupplement?: AliasSupplement;
    descriptions?: DescriptionEvent[];
    aliases?: AliasEvent[];
    /** The registry's spine order (buildSectionOrder(registry.books)); heuristic when omitted. */
    order?: SectionOrder;
  } = {},
): Registry {
  const { upTo, aliasSupplement = {}, order } = options;
  const raw = new Map<string, RegistryEntity>();

  for (const delta of [...deltas].sort((a, b) => newBookOf(a) - newBookOf(b))) {
    for (const ne of delta.newEntities) {
      const first = firstAnchorOf(ne, order);
      if (!first || !withinCutoff(first, upTo, order)) continue; // introduced after the cutoff
      const keptAnchors = [...new Set(ne.appearances.map(normalizeAnchor).filter((a) => withinCutoff(a, upTo, order)))];
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
      if (!withinCutoff(anchor, upTo, order)) continue;
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
    const resolved = resolveGroup(group, order);
    resolved.id = canonicalId;
    const extra = aliasSupplement[canonicalId];
    if (extra && extra.length > 0) {
      resolved.aliases = cleanAliases(resolved.canonicalName, [...resolved.aliases, ...extra]);
    }
    entities.push(resolved);
  }

  // Phase 2/2.5: overlay versioned descriptions & aliases. Keyed on whether an entity was
  // PROCESSED (has ≥1 event): a processed entity shows only events ≤ cutoff — never the blob,
  // so one that appears before its first version shows nothing rather than leaking the full
  // blob. An unprocessed entity (no events — e.g. a partial run hasn't reached it) keeps the
  // appearance-log blob, so partial runs degrade gracefully.
  const byId = new Map(entities.map((e) => [e.id, e]));

  if (options.descriptions && options.descriptions.length > 0) {
    const latest = new Map<string, DescriptionEvent>();
    const processed = new Set<string>();
    for (const ev of options.descriptions) {
      if (!byId.has(ev.id)) continue;
      processed.add(ev.id);
      if (!withinCutoff(ev.anchor, upTo, order)) continue;
      const cur = latest.get(ev.id);
      if (!cur || cmpAnchor(normalizeAnchor(ev.anchor), normalizeAnchor(cur.anchor), order) > 0) latest.set(ev.id, ev);
    }
    for (const id of processed) {
      const e = byId.get(id) as RegistryEntity;
      const ev = latest.get(id);
      e.description = ev ? ev.description : "";
      if (ev) e.significance = ev.significance;
    }
  }

  if (options.aliases && options.aliases.length > 0) {
    const collected = new Map<string, string[]>();
    const processed = new Set<string>();
    for (const ev of options.aliases) {
      if (!byId.has(ev.id)) continue;
      processed.add(ev.id);
      if (!withinCutoff(ev.anchor, upTo, order)) continue;
      const list = collected.get(ev.id) ?? [];
      list.push(ev.alias);
      collected.set(ev.id, list);
    }
    for (const id of processed) {
      const e = byId.get(id) as RegistryEntity;
      e.aliases = cleanAliases(e.canonicalName, collected.get(id) ?? []);
    }
  }

  entities.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  // Derived from the books that actually contributed a surviving appearance. This equals
  // the source's booksProcessed as long as every processed book yields ≥1 included anchor
  // (true for the synthesized DCC log); a processed-but-empty book would not appear here.
  const booksProcessed = [...new Set(entities.flatMap((e) => e.appearances).map(bookOf))].sort((a, b) => a - b);
  return { booksProcessed, entities };
}

/**
 * Map "B<book>·<label>" → entities appearing in that chapter, each with the entity's first
 * anchor there, sorted in reading order. Drives the chapter-sequential re-describe pass.
 * Keys by raw delta id (canonical in the synthesized DCC log, so no merge-map remap needed).
 */
export function chapterEntities(deltas: RegistryDelta[]): Map<string, Array<{ id: string; anchor: string }>> {
  const firstByKeyId = new Map<string, string>();
  const record = (id: string, anchorRaw: string): void => {
    const anchor = normalizeAnchor(anchorRaw);
    const parts = anchor.split("·");
    const chapKey = `${parts[0]}·${parts[1] ?? ""}`;
    const k = `${chapKey}\u001f${id}`;
    const prev = firstByKeyId.get(k);
    if (!prev || cmpAnchor(anchor, prev) < 0) firstByKeyId.set(k, anchor);
  };
  for (const d of deltas) {
    for (const ne of d.newEntities) for (const a of ne.appearances) record(ne.id, a);
    for (const m of d.matched) record(m.id, m.anchor);
  }
  const out = new Map<string, Array<{ id: string; anchor: string }>>();
  for (const [k, anchor] of firstByKeyId) {
    const [chapKey, id] = k.split("\u001f") as [string, string];
    const list = out.get(chapKey) ?? [];
    list.push({ id, anchor });
    out.set(chapKey, list);
  }
  for (const list of out.values()) list.sort((x, y) => cmpAnchor(x.anchor, y.anchor));
  return out;
}
