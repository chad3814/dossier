import { describe, expect, it } from "vitest";
import { buildRedescribeConstants } from "../src/gen-redescribe.js";
import { validateDescriptions } from "../src/validate-descriptions.js";
import type { DescriptionEvent, Registry, RegistryEntity } from "../src/types.js";

function mk(p: Partial<RegistryEntity> & { id: string; canonicalName: string }): RegistryEntity {
  return {
    aliases: [], type: "person", tags: ["in_world"], significance: "minor",
    description: "", firstAppearance: null, appearances: [], ...p,
  };
}

const reg: Registry = {
  booksProcessed: [1],
  entities: [
    mk({ id: "carl", canonicalName: "Carl", firstAppearance: { anchor: "B1·C1·¶1", snippet: "" }, appearances: ["B1·C1·¶1", "B3·C1·¶10"] }),
  ],
};

describe("validateDescriptions", () => {
  it("passes for ordered events whose first version is at/after earliest appearance", () => {
    const evs: DescriptionEvent[] = [
      { id: "carl", anchor: "B1·C1·¶1", description: "a", significance: "minor" },
      { id: "carl", anchor: "B3·C1·¶10", description: "b", significance: "major" },
    ];
    expect(validateDescriptions(reg, evs).errors).toEqual([]);
  });

  it("flags out-of-order versions", () => {
    const evs: DescriptionEvent[] = [
      { id: "carl", anchor: "B3·C1·¶10", description: "b", significance: "major" },
      { id: "carl", anchor: "B1·C1·¶1", description: "a", significance: "minor" },
    ];
    expect(validateDescriptions(reg, evs).errors.some((e) => /order/i.test(e))).toBe(true);
  });

  it("flags an unknown entity id", () => {
    const { errors } = validateDescriptions(reg, [{ id: "ghost", anchor: "B1·C1·¶1", description: "x", significance: "minor" }]);
    expect(errors.some((e) => /ghost/.test(e))).toBe(true);
  });

  it("warns on missing coverage only when requested", () => {
    expect(validateDescriptions(reg, [], {}).warnings).toEqual([]);
    expect(validateDescriptions(reg, [], { requireCoverage: true }).warnings.some((w) => /carl/.test(w))).toBe(true);
  });
});

describe("buildRedescribeConstants", () => {
  it("orders chapters by manifest, lists appearing entities, seeds latest prior descriptions", () => {
    const out = buildRedescribeConstants({
      bookNumber: 2,
      manifestSections: [{ label: "C1", file: "001-C1.txt" }],
      chapterMap: new Map([["B2·C1", [{ id: "carl", anchor: "B2·C1·¶3" }]]]),
      index: [{ id: "carl", canonicalName: "Carl", type: "person" }],
      priorEvents: [
        { id: "carl", anchor: "B1·C1·¶1", description: "early", significance: "minor" },
        { id: "carl", anchor: "B1·C9·¶1", description: "later", significance: "supporting" },
      ],
      aliasesById: { carl: ["the Crawler", "Crawler #4,122"] },
    });
    expect(out.chapters[0]!.entities[0]).toMatchObject({ id: "carl", anchor: "B2·C1·¶3", canonicalName: "Carl", type: "person" });
    expect(out.seed.carl).toEqual({ description: "later", significance: "supporting" });
    expect(out.aliasesById.carl).toEqual(["the Crawler", "Crawler #4,122"]);
  });

  it("drops entities with no metadata and chapters keep manifest order", () => {
    const out = buildRedescribeConstants({
      bookNumber: 1,
      manifestSections: [{ label: "Prologue", file: "001-Prologue.txt" }, { label: "C1", file: "002-C1.txt" }],
      chapterMap: new Map([
        ["B1·Prologue", [{ id: "carl", anchor: "B1·Prologue·¶2" }]],
        ["B1·C1", [{ id: "ghost", anchor: "B1·C1·¶1" }]],
      ]),
      index: [{ id: "carl", canonicalName: "Carl", type: "person" }],
      priorEvents: [],
      aliasesById: { carl: ["the Crawler"] },
    });
    expect(out.chapters.map((c) => c.label)).toEqual(["Prologue", "C1"]);
    expect(out.chapters[0]!.entities.map((e) => e.id)).toEqual(["carl"]);
    expect(out.chapters[1]!.entities).toEqual([]); // ghost dropped (no metadata)
    expect(out.seed).toEqual({});
  });
});
