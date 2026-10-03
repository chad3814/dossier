import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "./log.js";
import { resolveSeriesOrExit } from "./series.js";
import { synthesizeLog } from "./synthesize.js";
import type { Registry, RegistryDelta } from "./types.js";

/** Recursively sort object keys so deep equality ignores key order but respects array order. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = stable((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** Reproduction equality on the entity-bearing fields only (books is manifest-derived metadata). */
export function registryReproEquals(a: Registry, b: Registry): boolean {
  const strip = (r: Registry) => ({ booksProcessed: r.booksProcessed, entities: r.entities });
  return JSON.stringify(stable(strip(a))) === JSON.stringify(stable(strip(b)));
}

/** Compare a through-book-N materialization against a committed snapshot. Diagnostic only. */
export function snapshotDiagnostic(through: Registry, snap: Registry): string {
  if (JSON.stringify(stable(through)) === JSON.stringify(stable(snap))) return "MATCH";
  const sameSet = through.entities.length === snap.entities.length;
  return (
    `entity set ${sameSet ? "matches" : `differs (${through.entities.length} vs ${snap.entities.length})`}, ` +
    `fields differ (full-series descriptions/aliases — expected before Phase-2 description versioning)`
  );
}

/**
 * Derive the position-gated event log from the committed registry and persist it
 * under `<series>/log/`, then verify that materializing the written log
 * reproduces the registry exactly. registry.json is the source of truth; the log
 * is its derived, queryable, position-gated form (the basis for `view`).
 */
function main(): void {
  const { paths } = resolveSeriesOrExit(process.argv.slice(2), "npm run migrate-to-log -- --series <id>");
  if (!existsSync(paths.registry)) {
    console.error(`migrate-to-log: ${paths.registry} not found`);
    process.exit(1);
  }
  const registry = JSON.parse(readFileSync(paths.registry, "utf8")) as Registry;

  // 1. Synthesize the complete per-book log from the registry and write it.
  mkdirSync(paths.logDir, { recursive: true });
  const log = synthesizeLog(registry);
  for (const delta of log) {
    const book = delta.booksProcessed[0];
    writeFileSync(join(paths.logDir, `delta-book${book}.json`), JSON.stringify(delta), "utf8");
  }

  // 2. Read the written log back and verify full materialization reproduces the registry (hard gate).
  const files = readdirSync(paths.logDir).filter((f) => /^delta-book\d+\.json$/.test(f));
  const deltas = files.map((f) => JSON.parse(readFileSync(join(paths.logDir, f), "utf8")) as RegistryDelta);
  const full = materialize(deltas);
  if (!registryReproEquals(full, registry)) {
    console.error(
      `migrate-to-log: FAILED reproduction — materialize(log) != registry.json ` +
        `(${full.entities.length} vs ${registry.entities.length} entities).`,
    );
    process.exit(1);
  }

  // 3. Diagnostic: every committed through-book-N snapshot vs the materialized view through B<N>. Not a gate.
  const diags: string[] = [];
  for (const f of readdirSync(paths.outputDir).sort()) {
    const m = /^registry\.books1-(\d+)\.json$/.exec(f);
    if (!m) continue;
    const n = Number.parseInt(m[1] as string, 10);
    const through = materialize(deltas, {}, { upTo: `B${n}·C99999` });
    const snap = JSON.parse(readFileSync(join(paths.outputDir, f), "utf8")) as Registry;
    diags.push(`${f}: ${snapshotDiagnostic(through, snap)}`);
  }

  console.log(
    `migrate-to-log: OK — wrote ${log.length}-book log to ${paths.id}/log/, reproduced registry.json (${full.entities.length} entities). ` +
      `snapshot diagnostics: ${diags.length ? diags.join("; ") : "none"}.`,
  );
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
