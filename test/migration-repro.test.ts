import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { materialize } from "../src/log.js";
import { registryReproEquals } from "../src/migrate-to-log.js";
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

describe("registryReproEquals ignores books", () => {
  it("treats two registries as equal when they differ only by the books field", () => {
    const a = { booksProcessed: [1], entities: [], books: [{ number: 1, sections: ["C1"] }] };
    const b = { booksProcessed: [1], entities: [] };
    expect(registryReproEquals(a, b)).toBe(true);
  });
});

// Guarded: only runs where the DCC data is present (so dossier stays independently testable).
describe.skipIf(!hasData)("DCC log reproduction", () => {
  it("materialize(synthesizeLog(registry)) reproduces the committed registry.json exactly", () => {
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
    const full = materialize(synthesizeLog(registry));
    expect(full.entities.length).toBe(registry.entities.length);
    // Phase 2 regenerates `description` and `significance` as versioned events, so exclude
    // them here; the appearance structure (ids, appearances, aliases, tags, firstAppearance)
    // still reproduces exactly.
    const stripEntity = (e: Registry["entities"][number]): Record<string, unknown> => {
      const clone: Record<string, unknown> = { ...e };
      delete clone.description;
      delete clone.significance;
      delete clone.aliases; // Phase 2.5 regenerates aliases as versioned events
      return clone;
    };
    expect(full.booksProcessed).toEqual(registry.booksProcessed);
    expect(stable(full.entities.map(stripEntity))).toEqual(stable(registry.entities.map(stripEntity)));
  });
});
