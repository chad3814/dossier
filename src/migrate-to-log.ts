import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "./log.js";
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

/**
 * Derive the position-gated event log from the committed registry and persist it
 * under `<series>/log/`, then verify that materializing the written log
 * reproduces the registry exactly. registry.json is the source of truth; the log
 * is its derived, queryable, position-gated form (the basis for `view`).
 */
function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const seriesDir = join(here, "..", "..", "dcc"); // casefiles/dcc
  const registryPath = join(seriesDir, "output", "registry.json");
  if (!existsSync(registryPath)) {
    console.error(`migrate-to-log: ${registryPath} not found`);
    process.exit(1);
  }
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;

  // 1. Synthesize the complete per-book log from the registry and write it.
  const logDir = join(seriesDir, "log");
  mkdirSync(logDir, { recursive: true });
  const log = synthesizeLog(registry);
  for (const delta of log) {
    const book = delta.booksProcessed[0];
    writeFileSync(join(logDir, `delta-book${book}.json`), JSON.stringify(delta), "utf8");
  }

  // 2. Read the written log back and verify full materialization reproduces the registry (hard gate).
  const files = readdirSync(logDir).filter((f) => /^delta-book\d+\.json$/.test(f));
  const deltas = files.map((f) => JSON.parse(readFileSync(join(logDir, f), "utf8")) as RegistryDelta);
  const full = materialize(deltas);
  if (JSON.stringify(stable(full)) !== JSON.stringify(stable(registry))) {
    console.error(
      `migrate-to-log: FAILED reproduction — materialize(log) != registry.json ` +
        `(${full.entities.length} vs ${registry.entities.length} entities).`,
    );
    process.exit(1);
  }

  // 3. Diagnostic: through-book-7 view vs the committed snapshot (not a hard gate).
  const through7 = materialize(deltas, {}, { upTo: "B7·C99999" });
  const snapPath = join(seriesDir, "output", "registry.books1-7.json");
  let diag = "skipped (no registry.books1-7.json)";
  if (existsSync(snapPath)) {
    const snap = JSON.parse(readFileSync(snapPath, "utf8")) as Registry;
    if (JSON.stringify(stable(through7)) === JSON.stringify(stable(snap))) {
      diag = "MATCH";
    } else {
      const sameSet = through7.entities.length === snap.entities.length;
      diag =
        `entity set ${sameSet ? "matches" : `differs (${through7.entities.length} vs ${snap.entities.length})`}, ` +
        `fields differ (full-series descriptions/aliases — expected before Phase-2 description versioning)`;
    }
  }

  console.log(
    `migrate-to-log: OK — wrote ${log.length}-book log to dcc/log/, reproduced registry.json (${full.entities.length} entities). ` +
      `through-B7 diagnostic: ${diag}.`,
  );
}

main();
