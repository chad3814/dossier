import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anchorSortKey, normalizeAnchor } from "./registry.js";
import type { DescriptionEvent, Registry } from "./types.js";

function cmp(a: string, b: string): number {
  const ka = anchorSortKey(a);
  const kb = anchorSortKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
}

/**
 * Structural checks on a description-event log against the registry:
 * - every event references a known entity id,
 * - per entity, versions are in non-decreasing anchor order,
 * - the first version is at/after the entity's earliest appearance,
 * - (optional) coverage: every appearing entity has at least one version.
 * Returns errors (hard) and warnings (soft).
 */
export function validateDescriptions(
  registry: Registry,
  events: DescriptionEvent[],
  options: { requireCoverage?: boolean } = {},
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(registry.entities.map((e) => [e.id, e]));
  const grouped = new Map<string, DescriptionEvent[]>();

  for (const ev of events) {
    if (!byId.has(ev.id)) {
      errors.push(`unknown entity id "${ev.id}" in description event @ ${ev.anchor}`);
      continue;
    }
    const list = grouped.get(ev.id) ?? [];
    list.push(ev);
    grouped.set(ev.id, list);
  }

  for (const [id, evs] of grouped) {
    for (let i = 1; i < evs.length; i++) {
      if (cmp(normalizeAnchor(evs[i]!.anchor), normalizeAnchor(evs[i - 1]!.anchor)) < 0) {
        errors.push(`"${id}": description versions out of anchor order (${evs[i - 1]!.anchor} then ${evs[i]!.anchor})`);
      }
    }
    const e = byId.get(id)!;
    const earliest = [...e.appearances].map(normalizeAnchor).sort(cmp)[0];
    if (earliest && cmp(normalizeAnchor(evs[0]!.anchor), earliest) < 0) {
      errors.push(`"${id}": first version @ ${evs[0]!.anchor} precedes earliest appearance ${earliest}`);
    }
  }

  if (options.requireCoverage) {
    for (const e of registry.entities) {
      if (e.appearances.length > 0 && !grouped.has(e.id)) warnings.push(`"${e.id}" has no description version`);
    }
  }

  return { errors, warnings };
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const seriesDir = join(here, "..", "..", "dcc");
  const events = JSON.parse(readFileSync(join(seriesDir, "log", "descriptions.json"), "utf8")) as DescriptionEvent[];
  const registry = JSON.parse(readFileSync(join(seriesDir, "output", "registry.json"), "utf8")) as Registry;
  const { errors, warnings } = validateDescriptions(registry, events);
  for (const w of warnings) console.warn(`warn: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  console.log(`validate-descriptions: ${events.length} events, ${errors.length} errors, ${warnings.length} warnings`);
  if (errors.length > 0) process.exit(1);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
