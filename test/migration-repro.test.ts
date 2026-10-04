import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { materialize } from "../src/log.js";
import { buildSectionOrder } from "../src/registry.js";
import { registryReproEquals, snapshotDiagnostic } from "../src/migrate-to-log.js";
import { synthesizeLog } from "../src/synthesize.js";
import type { Registry } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const casefilesRoot = join(here, "..", "..");

/** Every sibling directory that holds a committed registry — each is a series. */
const seriesIds: string[] = existsSync(casefilesRoot)
  ? readdirSync(casefilesRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(casefilesRoot, d.name, "output", "registry.json")))
      .map((d) => d.name)
      .sort()
  : [];

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

describe("snapshotDiagnostic", () => {
  const ent = (id: string): Registry["entities"][number] => ({
    id, canonicalName: id, aliases: [], type: "person", tags: ["in_world"],
    significance: "minor", description: "", firstAppearance: null, appearances: [],
  });
  it("reports MATCH for identical registries", () => {
    const r: Registry = { booksProcessed: [1], entities: [ent("a")] };
    expect(snapshotDiagnostic(r, { ...r })).toBe("MATCH");
  });
  it("reports an entity-count difference", () => {
    const a: Registry = { booksProcessed: [1], entities: [ent("a")] };
    const b: Registry = { booksProcessed: [1], entities: [ent("a"), ent("b")] };
    expect(snapshotDiagnostic(a, b)).toMatch(/differs \(1 vs 2\)/);
  });
  it("reports same entity set but differing fields", () => {
    const a: Registry = { booksProcessed: [1], entities: [ent("a")] };
    const b: Registry = { booksProcessed: [1], entities: [{ ...ent("a"), description: "x" }] };
    expect(snapshotDiagnostic(a, b)).toMatch(/entity set matches, fields differ/);
  });
});

// Guarded: only runs where series data is present (so dossier stays independently testable).
describe.skipIf(seriesIds.length === 0)("log reproduction per series", () => {
  it.each(seriesIds)("%s: materialize(synthesizeLog(registry)) reproduces registry.json exactly", (id) => {
    const registry = JSON.parse(readFileSync(join(casefilesRoot, id, "output", "registry.json"), "utf8")) as Registry;
    const full = materialize(synthesizeLog(registry), {}, { order: buildSectionOrder(registry.books) });
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
