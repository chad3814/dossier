import { readFileSync, writeFileSync } from "node:fs";
import { dedupe } from "./registry.js";
import { resolveSeriesOrExit } from "./series.js";
import type { Registry } from "./types.js";

function main(): void {
  const { paths } = resolveSeriesOrExit(process.argv.slice(2), "npm run dedupe -- --series <id>");
  const before = JSON.parse(readFileSync(paths.registry, "utf8")) as Registry;
  const { registry, merged } = dedupe(before);
  writeFileSync(paths.registry, JSON.stringify(registry, null, 2) + "\n", "utf8");
  console.log(
    `dedupe: ${before.entities.length} -> ${registry.entities.length} entities (${merged} merged) in ${paths.id}/output/registry.json`,
  );
}

main();
