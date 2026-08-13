/**
 * Entity-id history.
 *
 * `corrections.json` is written against the ids extraction emitted, but it is replayed against
 * data a previous pass already reshaped — and `aliases.raw.json` is never rewritten at all. So
 * both the raw log and the corrections' own op targets can name ids the registry no longer has.
 * These helpers map a historical id forward to the entity that absorbed it.
 */

/** The subset of a corrections file that rewrites entity ids. */
export interface IdRewritingCorrections {
  renameIds?: Array<{ from: string; to: string }>;
  merges?: Array<{ from: string; into: string }>;
}

/** Build an id-history map (historical id -> its successor) from a corrections file. */
export function correctionIdMap(corrections: IdRewritingCorrections): Map<string, string> {
  const map = new Map<string, string>();
  for (const { from, to } of corrections.renameIds ?? []) map.set(from, to);
  for (const { from, into } of corrections.merges ?? []) map.set(from, into);
  return map;
}

/**
 * Resolve a possibly-historical id to a current registry id, or null if it cannot be resolved.
 * Follows chains (rename then merge) and tolerates cycles.
 *
 * An id that still exists in the registry always wins: `renameIds` is skipped when its target
 * already exists and `merges` is skipped when its source is gone, so a map entry alone does not
 * prove the op ran. Only redirect ids the registry no longer knows.
 */
export function resolveHistoricalId(
  id: string,
  currentIds: ReadonlySet<string>,
  idMap: ReadonlyMap<string, string>,
): string | null {
  if (currentIds.has(id)) return id;
  const seen = new Set<string>([id]);
  let cursor = id;
  for (;;) {
    const next = idMap.get(cursor);
    if (next === undefined || seen.has(next)) return null;
    if (currentIds.has(next)) return next;
    seen.add(next);
    cursor = next;
  }
}
