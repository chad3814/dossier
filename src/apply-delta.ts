import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyDelta, readRegistryOrEmpty } from "./registry.js";
import { resolveSeriesOrExit } from "./series.js";
import type { RegistryDelta } from "./types.js";

function main(): void {
  const usage = "npm run apply-delta -- --series <id> <delta.json>";
  const { paths, rest } = resolveSeriesOrExit(process.argv.slice(2), usage);
  const deltaArg = rest[0];
  if (!deltaArg) {
    console.error(`usage: ${usage}`);
    process.exit(1);
  }
  const registry = readRegistryOrEmpty(paths.registry); // empty for a series' first book
  const delta = JSON.parse(readFileSync(resolve(deltaArg), "utf8")) as RegistryDelta;

  const { registry: next, added, appended, dropped } = applyDelta(registry, delta);
  mkdirSync(paths.outputDir, { recursive: true });
  writeFileSync(paths.registry, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(
    `apply-delta: +${added} new entities, ${appended} anchors appended to existing, ${dropped} dropped (unknown id) — now ${next.entities.length} entities, books ${next.booksProcessed.join(", ")}`,
  );
}

main();
