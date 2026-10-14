import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { anchorSortKey, buildSectionOrder, readRegistryOrEmpty, type SectionOrder } from "./registry.js";
import { resolveSeriesOrExit } from "./series.js";
import type { DescriptionEvent, Registry, Significance } from "./types.js";

/** Share of entities (by total appearances, highest first) in each tier; the remainder is "mentioned". */
export interface TierShares {
  major: number;
  supporting: number;
  minor: number;
}

/** Mirrors the mix of the DCC registry: ~2% major, 15% supporting, 45% minor, the rest mentioned. */
export const DEFAULT_SHARES: TierShares = { major: 0.02, supporting: 0.15, minor: 0.45 };

export interface Thresholds {
  major: number;
  supporting: number;
  minor: number;
}

/** Minimum cumulative appearance count for each tier, from the registry-wide distribution. */
export function tierThresholds(totals: number[], shares: TierShares = DEFAULT_SHARES): Thresholds {
  const sorted = [...totals].sort((a, b) => b - a);
  const at = (share: number): number => {
    const n = Math.max(1, Math.ceil(sorted.length * share));
    return sorted[Math.min(n, sorted.length) - 1] ?? Infinity;
  };
  const major = at(shares.major);
  const supporting = Math.min(at(shares.major + shares.supporting), major);
  const minor = Math.min(at(shares.major + shares.supporting + shares.minor), supporting);
  return { major, supporting, minor };
}

export function tierFor(count: number, t: Thresholds): Significance {
  if (count >= t.major) return "major";
  if (count >= t.supporting) return "supporting";
  if (count >= t.minor) return "minor";
  return "mentioned";
}

type Key = [number, number, number];
const cmp = (a: Key, b: Key): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Tiers that get a synthetic event where an entity crosses into them (they drive prominence ordering). */
const CROSSING_TIERS: ReadonlySet<Significance> = new Set<Significance>(["supporting", "major"]);

/**
 * Re-derive every description event's significance from the entity's cumulative appearance count
 * at that event's anchor, against registry-wide thresholds. Deterministic, consistent across
 * books regardless of which agent run wrote the event, and non-decreasing as the reader advances
 * (cumulative counts only grow). Events for ids missing from the registry are left unchanged.
 *
 * A reader's rating comes from the latest event at or before their position, so an entity that
 * keeps growing after its last description event would otherwise stay stuck at an old tier. Where
 * an entity crosses into "supporting" or "major" with no event at that appearance, a copy of its
 * latest description is added there carrying the new tier. The result is in reading order.
 */
export function normalizeSignificance(
  events: DescriptionEvent[],
  registry: Registry,
  order: SectionOrder,
  shares: TierShares = DEFAULT_SHARES,
): DescriptionEvent[] {
  const thresholds = tierThresholds(registry.entities.map((e) => e.appearances.length), shares);
  const keys = new Map<string, Key[]>();
  for (const e of registry.entities) keys.set(e.id, e.appearances.map((a) => anchorSortKey(a, order)).sort(cmp));

  const countAt = (ks: Key[], at: Key): number => {
    let lo = 0;
    let hi = ks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const k = ks[mid];
      if (k && cmp(k, at) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const out: Array<{ ev: DescriptionEvent; key: Key }> = [];
  const byId = new Map<string, Array<{ ev: DescriptionEvent; key: Key }>>();
  for (const ev of events) {
    const ks = keys.get(ev.id);
    const key = anchorSortKey(ev.anchor, order);
    const row = { ev: ks ? { ...ev, significance: tierFor(countAt(ks, key), thresholds) } : ev, key };
    out.push(row);
    if (ks) byId.set(ev.id, [...(byId.get(ev.id) ?? []), row]);
  }

  const anchorOf = new Map<string, string>();
  for (const e of registry.entities) for (const a of e.appearances) anchorOf.set(`${e.id}\u0000${anchorSortKey(a, order).join(",")}`, a);
  for (const [id, rows] of byId) {
    const ks = keys.get(id);
    if (!ks) continue;
    const sorted = [...rows].sort((a, b) => cmp(a.key, b.key));
    for (const tier of ["supporting", "major"] as const) {
      if (!CROSSING_TIERS.has(tier) || (tier === "supporting" && thresholds.supporting >= thresholds.major)) continue;
      const need = thresholds[tier];
      const crossing = ks[need - 1];
      if (!crossing || need < 1) continue;
      if (sorted.some((r) => cmp(r.key, crossing) === 0)) continue;
      const prior = [...sorted].reverse().find((r) => cmp(r.key, crossing) < 0);
      const anchor = anchorOf.get(`${id}\u0000${crossing.join(",")}`);
      if (!prior || !anchor) continue;
      out.push({ ev: { ...prior.ev, anchor, significance: tierFor(need, thresholds) }, key: crossing });
    }
  }
  return out.sort((a, b) => cmp(a.key, b.key)).map((r) => r.ev);
}

function main(): void {
  const { paths } = resolveSeriesOrExit(process.argv.slice(2), "npm run normalize-significance -- --series <id>");
  const registry = readRegistryOrEmpty(paths.registry);
  const descPath = join(paths.logDir, "descriptions.json");
  const events = JSON.parse(readFileSync(descPath, "utf8")) as DescriptionEvent[];
  const out = normalizeSignificance(events, registry, buildSectionOrder(registry.books));
  writeFileSync(descPath, JSON.stringify(out, null, 2) + "\n", "utf8");
  const mix: Record<string, number> = {};
  const last = new Map<string, Significance>();
  out.forEach((e) => last.set(e.id, e.significance));
  for (const s of last.values()) mix[s] = (mix[s] ?? 0) + 1;
  console.log(`normalize-significance: ${events.length} -> ${out.length} events; final mix over ${last.size} described entities: ${JSON.stringify(mix)}`);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
