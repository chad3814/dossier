import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyDelta } from "./registry.js";
import { resolveSeriesOrExit } from "./series.js";
import type { Registry, RegistryDelta } from "./types.js";

function main(): void {
  const usage = "npm run apply-delta -- --series <id> <delta.json>";
  const { paths, rest } = resolveSeriesOrExit(process.argv.slice(2), usage);
  const deltaArg = rest[0];
  if (!deltaArg) {
    console.error(`usage: ${usage}`);
    process.exit(1);
  }
  const registry = JSON.parse(readFileSync(paths.registry, "utf8")) as Registry;
  const delta = JSON.parse(readFileSync(resolve(deltaArg), "utf8")) as RegistryDelta;

  const { registry: next, added, appended, dropped } = applyDelta(registry, delta);
  writeFileSync(paths.registry, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(
    `apply-delta: +${added} new entities, ${appended} anchors appended to existing, ${dropped} dropped (unknown id) — now ${next.entities.length} entities, books ${next.booksProcessed.join(", ")}`,
  );
}

main();
