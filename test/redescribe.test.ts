import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildRedescribeConstants, renderRedescribeBlock } from "../src/gen-redescribe.js";
import { isNoiseAlias, reconcileAliases } from "../src/reconcile-aliases.js";
import { buildSectionOrder } from "../src/registry.js";
import { validateAliases, validateDescriptions } from "../src/validate-descriptions.js";
import type { AliasEvent, DescriptionEvent, Registry, RegistryEntity } from "../src/types.js";

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

describe("reconcileAliases", () => {
  it("adds a registry alias never matched in text at the entity's last appearance", () => {
    const r: Registry = {
      booksProcessed: [1],
      entities: [mk({ id: "carl", canonicalName: "Carl", aliases: ["the Crawler", "Crawler #4,122"], appearances: ["B1·C1·¶1", "B3·C9·¶2"] })],
    };
    const events: AliasEvent[] = [{ id: "carl", anchor: "B1·C2·¶3", alias: "the Crawler" }];
    const out = reconcileAliases(r, events);
    expect(out.length).toBe(2);
    expect(out.find((e) => e.alias === "Crawler #4,122")!.anchor).toBe("B3·C9·¶2");
  });

  it("leaves an already-matched alias untouched (no duplicate)", () => {
    const r: Registry = {
      booksProcessed: [1],
      entities: [mk({ id: "carl", canonicalName: "Carl", aliases: ["the Crawler"], appearances: ["B1·C1·¶1"] })],
    };
    const out = reconcileAliases(r, [{ id: "carl", anchor: "B1·C1·¶1", alias: "the Crawler" }]);
    expect(out.length).toBe(1);
  });

  it("drops noise aliases and collapses duplicates to the earliest anchor", () => {
    const r: Registry = {
      booksProcessed: [1],
      entities: [mk({ id: "carl", canonicalName: "Carl", aliases: ["the Crawler", "me"], appearances: ["B1·C1·¶1", "B3·C9·¶2"] })],
    };
    const out = reconcileAliases(r, [
      { id: "carl", anchor: "B3·C1·¶1", alias: "the Crawler" }, // later duplicate
      { id: "carl", anchor: "B1·C2·¶3", alias: "the Crawler" }, // earlier — wins
      { id: "carl", anchor: "B1·C1·¶1", alias: "me" }, // noise — dropped
    ]);
    expect(out.map((e) => e.alias)).toEqual(["the Crawler"]); // "me" dropped, no dup
    expect(out[0]!.anchor).toBe("B1·C2·¶3"); // earliest kept
  });
});

describe("isNoiseAlias", () => {
  it("flags bare pronouns/articles but not real name-forms", () => {
    expect(isNoiseAlias("me")).toBe(true);
    expect(isNoiseAlias("She")).toBe(true);
    expect(isNoiseAlias("the")).toBe(true);
    expect(isNoiseAlias("the cat")).toBe(false);
    expect(isNoiseAlias("Crawler #4,122")).toBe(false);
    expect(isNoiseAlias("Donut")).toBe(false);
  });
});

describe("validateAliases", () => {
  const reg2: Registry = {
    booksProcessed: [1],
    entities: [mk({ id: "carl", canonicalName: "Carl", appearances: ["B1·C1·¶1"] })],
  };
  it("flags unknown ids and out-of-order events", () => {
    expect(validateAliases(reg2, [{ id: "ghost", anchor: "B1·C1·¶1", alias: "x" }]).errors.some((e) => /ghost/.test(e))).toBe(true);
    const ooo: AliasEvent[] = [
      { id: "carl", anchor: "B3·C1·¶1", alias: "b" },
      { id: "carl", anchor: "B1·C1·¶1", alias: "a" },
    ];
    expect(validateAliases(reg2, ooo).errors.some((e) => /order/i.test(e))).toBe(true);
  });
  it("passes for ordered events with known ids", () => {
    expect(validateAliases(reg2, [{ id: "carl", anchor: "B1·C1·¶1", alias: "a" }]).errors).toEqual([]);
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
    expect(out.chapters[0]!.entities[0]).toEqual({ id: "carl", anchor: "B2·C1·¶3" });
    expect(out.entityMeta.carl).toEqual({ canonicalName: "Carl", type: "person" });
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

describe("renderRedescribeBlock", () => {
  it("emits per-book and series constants between the markers", () => {
    const block = renderRedescribeBlock(
      { bookNumber: 2, chapters: [], entityMeta: {}, seed: {}, aliasesById: {} },
      "/d/sections",
      { id: "demo", title: "Demo", author: "A. Writer", notes: ["Note."] },
    );
    expect(block.startsWith("// ===== per-book constants (generated by gen-redescribe.ts) =====")).toBe(true);
    expect(block).toContain("const bookNumber = 2;");
    expect(block).toContain('const sectionDir = "/d/sections";');
    expect(block).toContain("const chapters = [];");
    expect(block).toContain('const seriesId = "demo";');
    expect(block).toContain('const seriesTitle = "Demo";');
    expect(block).toContain('const seriesAuthor = "A. Writer";');
    expect(block).toContain('const seriesNotes = ["Note."];');
    expect(block.endsWith("// ===================================================")).toBe(true);
  });
});

describe("workflow/redescribe-book.js template", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "workflow", "redescribe-book.js"), "utf8");

  it("is series-neutral and reads the series constants", () => {
    for (const leak of ["Dungeon Crawler Carl", "Dinniman", "DCC", "dcc-"]) {
      expect(src, `template still mentions ${leak}`).not.toContain(leak);
    }
    expect(src).toContain('"${seriesTitle}" by ${seriesAuthor}');
    expect(src).toContain("${seriesRules}");
    expect(src).toContain("meta = {\n  name: 'dossier-redescribe-incremental'");
  });
});

describe("workflow/redescribe-book.js return shape", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "workflow", "redescribe-book.js"), "utf8");
  it("returns description and alias events in chunks under the runner's 4096-item array cap", () => {
    expect(src).toMatch(/const CHUNK = 4000;/);
    expect(src).toContain("descriptionEventChunks");
    expect(src).toContain("aliasEventChunks");
    expect(src).not.toMatch(/return \{ bookNumber, descriptionEvents, aliasEvents \}/);
  });
});

describe("validateDescriptions / validateAliases use the registry's spine order", () => {
  const spine: Registry = {
    booksProcessed: [1],
    entities: [mk({ id: "luceum", canonicalName: "Luceum", appearances: ["B1·C1·¶1", "B1·Synchronism·¶20", "B1·Synchronism-2·¶16"] })],
    books: [{ number: 1, sections: ["C1", "Synchronism", "Synchronism-2"] }],
  };
  it("accepts versions in two non-standard sections when books[] says which comes first", () => {
    const evs: DescriptionEvent[] = [
      { id: "luceum", anchor: "B1·C1·¶1", description: "a", significance: "minor" },
      { id: "luceum", anchor: "B1·Synchronism·¶20", description: "b", significance: "minor" },
      { id: "luceum", anchor: "B1·Synchronism-2·¶16", description: "c", significance: "minor" },
    ];
    expect(validateDescriptions(spine, evs).errors).toEqual([]);
    const aevs: AliasEvent[] = [
      { id: "luceum", anchor: "B1·Synchronism·¶20", alias: "the Luceum" },
      { id: "luceum", anchor: "B1·Synchronism-2·¶16", alias: "Luceum gate" },
    ];
    expect(validateAliases(spine, aevs).errors).toEqual([]);
  });
  it("still flags a genuinely reversed pair within the spine order", () => {
    const evs: DescriptionEvent[] = [
      { id: "luceum", anchor: "B1·Synchronism-2·¶16", description: "c", significance: "minor" },
      { id: "luceum", anchor: "B1·Synchronism·¶20", description: "b", significance: "minor" },
    ];
    expect(validateDescriptions(spine, evs).errors.some((e) => /order/i.test(e))).toBe(true);
  });
});

describe("spine order in reconcileAliases and buildRedescribeConstants", () => {
  const books = [{ number: 1, sections: ["C1", "Synchronism", "Synchronism-2"] }];

  it("reconcileAliases keeps the EARLIEST anchor by spine order", () => {
    const r: Registry = {
      booksProcessed: [1],
      entities: [mk({ id: "luceum", canonicalName: "Luceum", aliases: ["the gate"], appearances: ["B1·Synchronism·¶20", "B1·Synchronism-2·¶16"] })],
      books,
    };
    const out = reconcileAliases(r, [
      { id: "luceum", anchor: "B1·Synchronism-2·¶16", alias: "the gate" },
      { id: "luceum", anchor: "B1·Synchronism·¶20", alias: "the gate" },
    ]);
    expect(out).toEqual([{ id: "luceum", anchor: "B1·Synchronism·¶20", alias: "the gate" }]);
  });

  it("buildRedescribeConstants seeds the LATEST prior description by spine order", () => {
    const priorEvents: DescriptionEvent[] = [
      { id: "luceum", anchor: "B1·Synchronism·¶20", description: "earlier", significance: "minor" },
      { id: "luceum", anchor: "B1·Synchronism-2·¶16", description: "later", significance: "minor" },
    ];
    const c = buildRedescribeConstants({
      bookNumber: 2,
      manifestSections: [{ label: "C1", file: "001-C1.txt" }],
      chapterMap: new Map([["B2·C1", [{ id: "luceum", anchor: "B2·C1·¶3" }]]]),
      index: [{ id: "luceum", canonicalName: "Luceum", type: "other" }],
      priorEvents,
      aliasesById: {},
      order: buildSectionOrder(books),
    });
    expect(c.seed["luceum"]!.description).toBe("later");
  });
});
