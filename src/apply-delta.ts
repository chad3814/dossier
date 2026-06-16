import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDelta } from "./registry.js";
import type { Registry, RegistryDelta } from "./types.js";

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const deltaArg = process.argv[2];
  if (!deltaArg) {
    console.error("usage: tsx src/apply-delta.ts <delta.json>");
    process.exit(1);
  }
  const registryPath = join(repoRoot, "output", "registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  const delta = JSON.parse(readFileSync(join(repoRoot, deltaArg), "utf8")) as RegistryDelta;

  const { registry: next, added, appended, dropped } = applyDelta(registry, delta);
  writeFileSync(registryPath, JSON.stringify(next, null, 2), "utf8");
  console.log(
    `apply-delta: +${added} new entities, ${appended} anchors appended to existing, ${dropped} dropped (unknown id) — now ${next.entities.length} entities, books ${next.booksProcessed.join(", ")}`,
  );
}

main();
