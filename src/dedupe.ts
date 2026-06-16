import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupe } from "./registry.js";
import type { Registry } from "./types.js";

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const arg = process.argv[2] ?? "output/registry.json";
  const path = join(repoRoot, arg);
  const before = JSON.parse(readFileSync(path, "utf8")) as Registry;
  const { registry, merged } = dedupe(before);
  writeFileSync(path, JSON.stringify(registry, null, 2), "utf8");
  console.log(
    `dedupe: ${before.entities.length} -> ${registry.entities.length} entities (${merged} merged) in ${arg}`,
  );
}

main();
