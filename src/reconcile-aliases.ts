import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDroppableAlias } from "./alias-clean.js";
import type { Corrections } from "./apply-corrections.js";
import { correctionIdMap, resolveHistoricalId } from "./id-history.js";
import { anchorSortKey, normalizeAnchor, normalizeName } from "./registry.js";
import type { AliasEvent, Registry, RegistryEntity } from "./types.js";

export { isNoiseAlias } from "./alias-clean.js";

function cmp(a: string, b: string): number {
  const ka = anchorSortKey(a);
  const kb = anchorSortKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
}

/**
 * Normalize an alias-event log: resolve historical ids via `idMap`, drop noise (bare
 * pronouns/articles), collapse duplicate (id, alias) pairs to their EARLIEST anchor (so
 * cross-book re-emission keeps the true first occurrence), then ensure completeness — any
 * registry alias never matched in text is added at the entity's LAST appearance (present at
 * full-series, never leaked early). Sorted by anchor then id.
 *
 * Pass `idMap` (see `correctionIdMap`) whenever the events predate a corrections pass.
 * Without it, an event whose entity was renamed or merged is dropped here and its alias is
 * re-added by the completeness step at the entity's last appearance — silently discarding the
 * anchor where the reader actually learns the name.
 */
export function reconcileAliases(
  registry: Registry,
  events: AliasEvent[],
  idMap: ReadonlyMap<string, string> = new Map(),
): AliasEvent[] {
  // 1. resolve historical ids + drop noise + keep earliest per (id, normalized alias)
  const byId = new Map<string, RegistryEntity>(registry.entities.map((e) => [e.id, e]));
  const currentIds = new Set<string>(byId.keys());
  const earliest = new Map<string, AliasEvent>();
  for (const ev of events) {
    const id = resolveHistoricalId(ev.id, currentIds, idMap);
    if (id === null) continue;
    const entity = byId.get(id);
    if (!entity) continue;
    if (isDroppableAlias(ev.alias, entity)) continue;
    const key = `${id} ${normalizeName(ev.alias)}`;
    const cur = earliest.get(key);
    if (!cur || cmp(normalizeAnchor(ev.anchor), normalizeAnchor(cur.anchor)) < 0) {
      earliest.set(key, { ...ev, id });
    }
  }
  const out = [...earliest.values()];

  // 2. reconcile: add any registry alias not yet represented, at the entity's last appearance
  const seenById = new Map<string, Set<string>>();
  for (const ev of out) {
    const set = seenById.get(ev.id) ?? new Set<string>();
    set.add(normalizeName(ev.alias));
    seenById.set(ev.id, set);
  }
  for (const ent of registry.entities) {
    const seen = seenById.get(ent.id) ?? new Set<string>();
    const last = [...ent.appearances].map(normalizeAnchor).sort(cmp).pop();
    if (!last) continue;
    for (const alias of ent.aliases) {
      if (isDroppableAlias(alias, ent)) continue;
      const n = normalizeName(alias);
      if (seen.has(n)) continue;
      out.push({ id: ent.id, anchor: last, alias });
      seen.add(n);
    }
  }

  out.sort((a, b) => cmp(normalizeAnchor(a.anchor), normalizeAnchor(b.anchor)) || a.id.localeCompare(b.id));
  return out;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const seriesDir = join(here, "..", "..", "dcc");
  const raw = JSON.parse(readFileSync(join(seriesDir, "log", "aliases.raw.json"), "utf8")) as AliasEvent[];
  const registry = JSON.parse(readFileSync(join(seriesDir, "output", "registry.json"), "utf8")) as Registry;
  const corrections = JSON.parse(readFileSync(join(seriesDir, "corrections.json"), "utf8")) as Corrections;

  const idMap = correctionIdMap(corrections);
  const reconciled = reconcileAliases(registry, raw, idMap);
  writeFileSync(join(seriesDir, "log", "aliases.json"), JSON.stringify(reconciled, null, 2), "utf8");
  console.log(`reconcile-aliases: ${raw.length} raw events -> ${reconciled.length} reconciled (noise dropped, deduped to earliest, unmatched added at last appearance)`);

  // Report ids the registry no longer knows. Their events are dropped and the completeness
  // step re-adds the aliases at the entity's last appearance, so a silent count here would
  // hide de-gated aliases.
  const currentIds = new Set<string>(registry.entities.map((e) => e.id));
  const unresolved = new Map<string, number>();
  for (const ev of raw) {
    if (resolveHistoricalId(ev.id, currentIds, idMap) === null) {
      unresolved.set(ev.id, (unresolved.get(ev.id) ?? 0) + 1);
    }
  }
  if (unresolved.size > 0) {
    const total = [...unresolved.values()].reduce((a, b) => a + b, 0);
    const listed = [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([id, n]) => `${id} (${n})`).join(", ");
    console.warn(
      `reconcile-aliases: WARNING dropped ${total} event(s) across ${unresolved.size} unknown id(s): ${listed}` +
      (unresolved.size > 10 ? ", ..." : "") +
      "\n  Add a renameIds/merges entry to corrections.json for each, or those aliases lose their true anchor.",
    );
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

