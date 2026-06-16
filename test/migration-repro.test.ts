import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { materialize } from "../src/log.js";
import { synthesizeLog } from "../src/synthesize.js";
import type { Registry } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const registryPath = join(here, "..", "..", "dcc", "output", "registry.json");
const hasData = existsSync(registryPath);

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

// Guarded: only runs where the DCC data is present (so dossier stays independently testable).
describe.skipIf(!hasData)("DCC log reproduction", () => {
  it("materialize(synthesizeLog(registry)) reproduces the committed registry.json exactly", () => {
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
    const full = materialize(synthesizeLog(registry));
    expect(full.entities.length).toBe(registry.entities.length);
    expect(stable(full)).toEqual(stable(registry));
  });
});
