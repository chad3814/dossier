import { anchorSortKey, normalizeAnchor, normalizeName } from "./registry.js";
import type { AliasEvent, Registry } from "./types.js";

function cmp(a: string, b: string): number {
  const ka = anchorSortKey(a);
  const kb = anchorSortKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
}

/**
 * Ensure every registry alias is represented in the alias-event log. Any alias the
 * re-describe pass never matched in text is added at the entity's LAST appearance anchor —
 * so it is present at the full-series view but never leaks early. Returns the merged list,
 * sorted by anchor then id.
 */
export function reconcileAliases(registry: Registry, events: AliasEvent[]): AliasEvent[] {
  const emittedById = new Map<string, Set<string>>(); // id -> normalized aliases already present
  for (const e of events) {
    const set = emittedById.get(e.id) ?? new Set<string>();
    set.add(normalizeName(e.alias));
    emittedById.set(e.id, set);
  }

  const out = [...events];
  for (const ent of registry.entities) {
    const seen = emittedById.get(ent.id) ?? new Set<string>();
    const last = [...ent.appearances].map(normalizeAnchor).sort(cmp).pop();
    if (!last) continue;
    for (const alias of ent.aliases) {
      const n = normalizeName(alias);
      if (seen.has(n)) continue;
      out.push({ id: ent.id, anchor: last, alias });
      seen.add(n);
    }
  }

  out.sort((a, b) => cmp(normalizeAnchor(a.anchor), normalizeAnchor(b.anchor)) || a.id.localeCompare(b.id));
  return out;
}
