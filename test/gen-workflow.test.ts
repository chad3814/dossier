import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildConstants, candidateIndex, injectConstants } from "../src/gen-workflow.js";

const series = { id: "demo", title: "Demo", author: "A. Writer", notes: ["Rule one.", "Rule two."] };

describe("buildConstants", () => {
  it("emits a valid constants block with embedded JSON", () => {
    const block = buildConstants(2, "/abs/sections", ["001-C1.txt"], [{ id: "carl", canonicalName: "Carl", aliases: [], type: "person" }], [1], series, {});
    expect(block).toContain("const bookNumber = 2;");
    expect(block).toContain('const sectionDir = "/abs/sections";');
    expect(block).toContain('const sectionFiles = ["001-C1.txt"];');
    expect(block).toContain('const startIds = ["carl"];');
    expect(block).toContain("const startBooksProcessed = [1];");
  });
});

describe("buildConstants series fields", () => {
  it("emits series identity and notes as constants", () => {
    const block = buildConstants(1, "/d", [], [], [], series, {});
    expect(block).toContain('const seriesId = "demo";');
    expect(block).toContain('const seriesTitle = "Demo";');
    expect(block).toContain('const seriesAuthor = "A. Writer";');
    expect(block).toContain('const seriesNotes = ["Rule one.","Rule two."];');
  });
});

describe("injectConstants", () => {
  const script = [
    "export const meta = {};",
    "// ===== per-book constants (edit between books) =====",
    "const bookNumber = 1;",
    "const startIndex = [];",
    "// ===================================================",
    "doWork(bookNumber, startIndex);",
  ].join("\n");

  it("replaces the block between the markers and preserves the surrounding script", () => {
    const out = injectConstants(script, buildConstants(2, "/d", ["a.txt"], [], [1], series, {}));
    expect(out).toContain("export const meta = {};");
    expect(out).toContain("const bookNumber = 2;");
    expect(out).toContain("doWork(bookNumber, startIndex);");
    expect(out).not.toContain("const bookNumber = 1;");
    // exactly one constants block remains
    expect(out.match(/per-book constants/g)).toHaveLength(1);
  });

  it("throws if the markers are missing", () => {
    expect(() => injectConstants("no markers here", "x")).toThrow();
  });
});

describe("workflow/book-extract.js template", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "workflow", "book-extract.js"), "utf8");

  it("is series-neutral: no DCC names or rules remain in the template", () => {
    for (const leak of ["Dungeon Crawler Carl", "Dinniman", "Donut", "Crawler #", "crawlers", "dcc-"]) {
      expect(src, `template still mentions ${leak}`).not.toContain(leak);
    }
  });

  it("declares the series constants between the markers and uses them in the prompts", () => {
    expect(src).toMatch(/const seriesId = ''/);
    expect(src).toMatch(/const seriesTitle = ''/);
    expect(src).toMatch(/const seriesAuthor = ''/);
    expect(src).toMatch(/const seriesNotes = \[\]/);
    expect(src).toContain('"${seriesTitle}" by ${seriesAuthor}');
    expect(src).toContain("${seriesRules}");
    expect(src).toContain("meta = {\n  name: 'dossier-extract-incremental'");
  });

  it("returns matched mentions and new entities in chunks under the runner's 4096-item array cap", () => {
    expect(src).toMatch(/const CHUNK = 4000;/);
    expect(src).toContain("matchedChunks");
    expect(src).toContain("newEntityChunks");
    expect(src).not.toMatch(/return \{[^}]*\bmatched,/);
  });
});

describe("workflow/book-extract.js normalizeName stays in sync with src/registry.ts", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "workflow", "book-extract.js"), "utf8");
  it("folds diacritics the same way (NFD + strip combining marks)", () => {
    expect(src).toContain(".normalize('NFD')");
    expect(src).toMatch(/\\u0300-\\u036f/);
  });
});

describe("workflow/book-extract.js feeds learned aliases back and forbids descriptive aliases", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "workflow", "book-extract.js"), "utf8");
  it("tracks aliases learned via matched entries and includes them in the volatile prompt tail", () => {
    expect(src).toMatch(/const learnedAliases = new Map\(\);/);
    expect(src).toContain("ALIASES LEARNED THIS BOOK");
    const start = src.indexOf("const extractPrompt = ");
    const body = src.slice(start, src.indexOf("`;", start) + 2);
    expect(body.indexOf("${JSON.stringify(candidates)}")).toBeLessThan(body.indexOf("ALIASES LEARNED THIS BOOK"));
    expect(body.indexOf("ALIASES LEARNED THIS BOOK")).toBeLessThan(body.indexOf("${path}"));
  });
  it("tells agents that aliases are names, never descriptive phrases or kinship terms", () => {
    expect(src).toMatch(/NEVER record descriptive phrases/i);
    expect(src).toMatch(/kinship/i);
  });
});

describe("agent settings flow into the extraction constants and template", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "workflow", "book-extract.js"), "utf8");
  it("buildConstants emits agentType/agentModel (null when unset)", () => {
    const withSettings = buildConstants(1, "/d", [], [], [], { ...series, agentType: "Explore", model: "fable" }, {});
    expect(withSettings).toContain('const agentType = "Explore";');
    expect(withSettings).toContain('const agentModel = "fable";');
    const without = buildConstants(1, "/d", [], [], [], series, {});
    expect(without).toContain("const agentType = null;");
    expect(without).toContain("const agentModel = null;");
  });
  it("the template spreads the settings into every agent call and asks for bracket-free anchors", () => {
    expect(src).toMatch(/const agentType = null;/);
    expect(src).toMatch(/const agentModel = null;/);
    expect(src).toMatch(/const agentOpts = \{/);
    expect((src.match(/\.\.\.agentOpts/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/WITHOUT the square brackets/);
  });
});

describe("candidateIndex: per-chapter candidates by text scan", () => {
  const index = [
    { id: "jason-asano", canonicalName: "Jason Asano", aliases: ["Jason", "Mr Asano"], type: "person" as const },
    { id: "humphrey", canonicalName: "Humphrey", aliases: ["Humphrey Geller", "Hump"], type: "person" as const },
    { id: "the-hierarchy", canonicalName: "The Hierarchy", aliases: ["the"], type: "faction" as const },
    { id: "map", canonicalName: "Map", aliases: [], type: "other" as const },
    { id: "darth-vader", canonicalName: "Darth Vader", aliases: [], type: "person" as const },
  ];
  it("keeps entities whose canonical name or any alias occurs as whole words, case-insensitively, in input order", () => {
    const text = "JASON woke up. Humphrey Geller smiled; the map glowed. 'Hump!' said Jason Asano.";
    expect(candidateIndex(index, text).map((e) => e.id)).toEqual(["jason-asano", "humphrey", "map"]);
  });
  it("ignores noise/short forms so 'the' never qualifies an entity, and does not match inside words", () => {
    expect(candidateIndex(index, "the mapping of The Hierarchy and its rules").map((e) => e.id)).toEqual(["the-hierarchy"]); // matched via canonical, never via alias "the"; "mapping" ≠ "map"
    expect(candidateIndex(index, "the Hierarchy’s rules; Humphrey's smile").map((e) => e.id)).toEqual(["humphrey", "the-hierarchy"]); // possessives still match
    expect(candidateIndex(index, "nothing relevant here").map((e) => e.id)).toEqual([]);
  });
});

describe("buildConstants emits a compact known-entity map and per-chapter candidate ids", () => {
  const index = [
    { id: "jason-asano", canonicalName: "Jason Asano", aliases: ["Jason"], type: "person" as const },
    { id: "nobody", canonicalName: "Nobody", aliases: [], type: "person" as const },
  ];
  it("includes only entities that are candidates in at least one chapter, keyed by id, and all ids in startIds", () => {
    const block = buildConstants(2, "/d", ["001-C1.txt", "002-C2.txt"], index, [1], series, { "001-C1.txt": ["jason-asano"], "002-C2.txt": [] });
    expect(block).toContain('const startIds = ["jason-asano","nobody"];');
    expect(block).toContain('const knownEntities = {"jason-asano":{"n":"Jason Asano","a":["Jason"],"t":"person"}};');
    expect(block).toContain('const candidatesByFile = {"001-C1.txt":["jason-asano"],"002-C2.txt":[]};');
    expect(block).not.toContain("startIndex");
  });
});

describe("workflow/book-extract.js uses per-chapter candidates instead of a whole-registry index", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "workflow", "book-extract.js"), "utf8");
  it("declares the candidate constants, expands them per chapter, and no longer embeds a frozen whole index", () => {
    expect(src).toMatch(/const startIds = \[\];/);
    expect(src).toMatch(/const knownEntities = \{\};/);
    expect(src).toMatch(/const candidatesByFile = \{\};/);
    expect(src).not.toContain("frozenIndexJson");
    expect(src).not.toContain("startIndex");
    expect(src).toContain("candidatesFor(sectionFiles[i])");
    expect(src).toContain("candidatesByFile[file]");
    const start = src.indexOf("const extractPrompt = ");
    const body = src.slice(start, src.indexOf("`;", start) + 2);
    const i1 = body.indexOf("${JSON.stringify(candidates)}"), i2 = body.indexOf("${JSON.stringify(addedThisBook)}"), i3 = body.indexOf("${path}");
    expect(i1).toBeGreaterThan(-1); expect(i1).toBeLessThan(i2); expect(i2).toBeLessThan(i3);
  });
});
