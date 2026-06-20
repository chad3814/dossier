import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BookSections,
  ChapterFindings,
  EntityTag,
  Registry,
  RegistryDelta,
  RegistryEntity,
  RegistryIndexEntry,
  Significance,
} from "./types.js";

/** Normalize a name for matching: lowercase, strip punctuation, collapse spaces. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Build the compact index handed to chapter agents (no descriptions/appearances). */
export function toIndex(registry: Registry): RegistryIndexEntry[] {
  return registry.entities.map((e) => ({
    id: e.id,
    canonicalName: e.canonicalName,
    aliases: e.aliases,
    type: e.type,
  }));
}

/**
 * Find registry entities whose canonical name or any alias matches `query`.
 * Returns exact normalized matches first, then substring matches, ranked by
 * specificity (longer matched string = more specific).
 */
export function lookup(registry: Registry, query: string): RegistryEntity[] {
  const q = normalizeName(query);
  if (!q) return [];
  const exact: RegistryEntity[] = [];
  const partial: Array<{ entity: RegistryEntity; score: number }> = [];
  for (const e of registry.entities) {
    const names = [e.canonicalName, ...e.aliases].map(normalizeName);
    if (names.includes(q)) {
      exact.push(e);
      continue;
    }
    let best = 0;
    for (const n of names) {
      if (!n) continue;
      if (n.includes(q) || q.includes(n)) best = Math.max(best, Math.min(n.length, q.length));
    }
    if (best > 0) partial.push({ entity: e, score: best });
  }
  partial.sort((a, b) => b.score - a.score);
  return [...exact, ...partial.map((p) => p.entity)];
}

/** Deterministic id from a canonical name plus a disambiguator. */
function makeId(canonicalName: string, existing: Set<string>): string {
  const base = normalizeName(canonicalName).replace(/\s+/g, "-") || "entity";
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

/**
 * Fold one chapter's findings into the registry, mutating and returning it.
 * Matched mentions append anchors to existing entities; new entities are created.
 * Anchors are de-duplicated; first appearance is preserved as the earliest seen.
 */
export function foldFindings(registry: Registry, findings: ChapterFindings): Registry {
  const byId = new Map(registry.entities.map((e) => [e.id, e]));
  const ids = new Set(registry.entities.map((e) => e.id));

  for (const m of findings.matched) {
    const entity = byId.get(m.id);
    if (!entity) continue;
    const anchor = normalizeAnchor(m.anchor);
    if (!entity.appearances.includes(anchor)) entity.appearances.push(anchor);
    if (!entity.firstAppearance) entity.firstAppearance = { anchor, snippet: m.snippet };
    if (m.aliases && m.aliases.length > 0) {
      entity.aliases = cleanAliases(entity.canonicalName, [...entity.aliases, ...m.aliases]);
    }
  }

  for (const fresh of findings.new) {
    const anchors = [...new Set(fresh.mentions.map((mn) => normalizeAnchor(mn.anchor)))];
    const id = makeId(fresh.name, ids);
    ids.add(id);
    const first = fresh.mentions[0] ?? null;
    const entity: RegistryEntity = {
      id,
      canonicalName: fresh.name,
      aliases: [...new Set(fresh.aliases)],
      type: fresh.type,
      tags: [fresh.tag],
      significance: "minor",
      description: "",
      firstAppearance: first ? { anchor: normalizeAnchor(first.anchor), snippet: first.snippet } : null,
      appearances: anchors,
    };
    registry.entities.push(entity);
    byId.set(id, entity);
  }
  return registry;
}

export function emptyRegistry(): Registry {
  return { booksProcessed: [], entities: [] };
}

/**
 * Fold a book's extraction delta into the registry. New entities are appended
 * (ids already assigned by the workflow); matched anchors/aliases are merged onto
 * existing entities by id. Anchors are normalized; aliases de-duplicated. Returns
 * the registry plus counts. Unknown matched ids are skipped and counted.
 */
export function applyDelta(
  registry: Registry,
  delta: RegistryDelta,
): { registry: Registry; added: number; appended: number; dropped: number } {
  const byId = new Map(registry.entities.map((e) => [e.id, e]));
  let added = 0;
  let appended = 0;
  let dropped = 0;

  for (const ne of delta.newEntities) {
    const existing = byId.get(ne.id);
    if (existing) {
      // Rare id collision — merge rather than duplicate.
      for (const a of ne.appearances) {
        const anchor = normalizeAnchor(a);
        if (!existing.appearances.includes(anchor)) existing.appearances.push(anchor);
      }
      existing.aliases = cleanAliases(existing.canonicalName, [...existing.aliases, ...ne.aliases]);
      continue;
    }
    const entity: RegistryEntity = { ...ne, appearances: [...new Set(ne.appearances.map(normalizeAnchor))] };
    registry.entities.push(entity);
    byId.set(entity.id, entity);
    added++;
  }

  for (const m of delta.matched) {
    const entity = byId.get(m.id);
    if (!entity) { dropped++; continue; }
    const anchor = normalizeAnchor(m.anchor);
    if (!entity.appearances.includes(anchor)) { entity.appearances.push(anchor); appended++; }
    if (!entity.firstAppearance) entity.firstAppearance = { anchor, snippet: "" };
    if (m.aliases.length > 0) {
      entity.aliases = cleanAliases(entity.canonicalName, [...entity.aliases, ...m.aliases]);
    }
  }

  const booksProcessed = [...new Set([...registry.booksProcessed, ...delta.booksProcessed])].sort((a, b) => a - b);
  return { registry: { booksProcessed, entities: registry.entities }, added, appended, dropped };
}

/** Leading title/role words that denote the same entity (e.g. "Crawler Frank Q" == "Frank Q"). */
const TITLE_PREFIXES = ["crawler"];

/** Merge key collapsing case, punctuation, and a leading title prefix. */
export function mergeKey(name: string): string {
  let n = normalizeName(name);
  for (const p of TITLE_PREFIXES) {
    if (n.startsWith(`${p} `)) n = n.slice(p.length + 1);
  }
  return n;
}

const SIG_RANK: Record<Significance, number> = { mentioned: 0, minor: 1, supporting: 2, major: 3 };

/** Strip surrounding brackets/whitespace agents sometimes copy, yielding a clean `B1·C3·¶5`. */
export function normalizeAnchor(anchor: string): string {
  const m = anchor.match(/B\d+·[^\s[\]]+·¶\d+/);
  return m ? m[0] : anchor.replace(/[[\]\s]/g, "");
}

/** Drop aliases equal to the canonical name (case-insensitive) and de-duplicate the rest. */
export function cleanAliases(canonicalName: string, aliases: string[]): string[] {
  const canon = normalizeName(canonicalName);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of aliases) {
    const n = normalizeName(a);
    if (!n || n === canon || seen.has(n)) continue;
    seen.add(n);
    out.push(a);
  }
  return out;
}

export interface SectionOrder {
  ordinal(book: number, label: string): number | undefined;
}

export function buildSectionOrder(books?: BookSections[]): SectionOrder {
  const map = new Map<string, number>();
  for (const b of books ?? []) {
    b.sections.forEach((label, i) => map.set(`${b.number}·${label}`, i));
  }
  return { ordinal: (book, label) => map.get(`${book}·${label}`) };
}

/** Heuristic section order from the label alone (fallback when no manifest order is known). */
function heuristicSectionOrder(label: string): number {
  if (/^C\d+$/i.test(label)) return Number.parseInt(label.slice(1), 10);
  if (/^Part\d+$/i.test(label)) return -1;
  const special: Record<string, number> = { epigraph: -4, prologue: -3, interlude: -2, epilogue: 9000 };
  return special[label.toLowerCase()] ??
    (/^Sec\d+/i.test(label) ? 10000 + (Number.parseInt(label.replace(/\D/g, ""), 10) || 0) : 8000);
}

/** Sort key for a `B<book>·<label>·¶<n>` anchor, putting anchors in reading order. */
export function anchorSortKey(anchor: string, order?: SectionOrder): [number, number, number] {
  const parts = anchor.split("·");
  const book = Number.parseInt((parts[0] ?? "").replace(/\D/g, ""), 10) || 0;
  const label = parts[1] ?? "";
  const para = Number.parseInt((parts[2] ?? "").replace(/\D/g, ""), 10) || 0;
  const sec = order?.ordinal(book, label) ?? heuristicSectionOrder(label);
  return [book, sec, para];
}

/** Normalize, de-duplicate, and sort anchors into reading order. */
export function cleanAnchors(anchors: string[], order?: SectionOrder): string[] {
  return [...new Set(anchors.map(normalizeAnchor))].sort((a, b) => {
    const ka = anchorSortKey(a, order);
    const kb = anchorSortKey(b, order);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

/** Resolve a group of variant entities into one canonical entity (dedupe's merge logic). */
export function resolveGroup(group: RegistryEntity[]): RegistryEntity {
  const primary = [...group].sort(
    (a, b) => b.appearances.length - a.appearances.length || a.canonicalName.length - b.canonicalName.length,
  )[0] as RegistryEntity;

  const aliasSet = new Set<string>();
  const anchorSet = new Set<string>();
  const tagSet = new Set<EntityTag>();
  let description = primary.description;
  let significance = primary.significance;
  for (const e of group) {
    if (e !== primary) aliasSet.add(e.canonicalName);
    e.aliases.forEach((a) => aliasSet.add(a));
    e.appearances.forEach((a) => anchorSet.add(a));
    e.tags.forEach((t) => tagSet.add(t));
    if (e.description.length > description.length) description = e.description;
    if (SIG_RANK[e.significance] > SIG_RANK[significance]) significance = e.significance;
  }
  aliasSet.delete(primary.canonicalName);

  return {
    ...primary,
    aliases: cleanAliases(primary.canonicalName, [...aliasSet]),
    appearances: cleanAnchors([...anchorSet]),
    tags: [...tagSet],
    description,
    significance,
    firstAppearance: primary.firstAppearance
      ? { ...primary.firstAppearance, anchor: normalizeAnchor(primary.firstAppearance.anchor) }
      : null,
  };
}

/**
 * Collapse entities that are obvious variants of one another (same name modulo
 * case/punctuation, or a leading "Crawler"-style title). Unions aliases,
 * appearances, and tags; keeps the most-attested name as canonical and the
 * strongest significance / longest description. Also sorts every entity's
 * appearances into reading order. Returns the new registry and the merge count.
 */
export function dedupe(registry: Registry): { registry: Registry; merged: number } {
  const groups = new Map<string, RegistryEntity[]>();
  for (const e of registry.entities) {
    const key = mergeKey(e.canonicalName);
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }

  const out: RegistryEntity[] = [];
  let merged = 0;
  for (const group of groups.values()) {
    merged += group.length - 1;
    out.push(resolveGroup(group));
  }

  out.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  return { registry: { booksProcessed: registry.booksProcessed, entities: out }, merged };
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const query = process.argv.slice(2).join(" ");
  if (!query) {
    console.error('usage: tsx src/registry.ts "<name to look up>"');
    process.exit(1);
  }
  const registryPath = join(repoRoot, "output", "registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  const hits = lookup(registry, query);
  if (hits.length === 0) {
    console.log(`No match for "${query}".`);
    return;
  }
  for (const h of hits.slice(0, 10)) {
    console.log(`${h.id}  ${h.canonicalName} [${h.type}]  aliases: ${h.aliases.join(", ") || "—"}`);
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
