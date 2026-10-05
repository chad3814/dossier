import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildConstants, injectConstants } from "../src/gen-workflow.js";

const series = { id: "demo", title: "Demo", author: "A. Writer", notes: ["Rule one.", "Rule two."] };

describe("buildConstants", () => {
  it("emits a valid constants block with embedded JSON", () => {
    const block = buildConstants(2, "/abs/sections", ["001-C1.txt"], [{ id: "carl" }], [1], series);
    expect(block).toContain("const bookNumber = 2;");
    expect(block).toContain('const sectionDir = "/abs/sections";');
    expect(block).toContain('const sectionFiles = ["001-C1.txt"];');
    expect(block).toContain('const startIndex = [{"id":"carl"}];');
    expect(block).toContain("const startBooksProcessed = [1];");
  });
});

describe("buildConstants series fields", () => {
  it("emits series identity and notes as constants", () => {
    const block = buildConstants(1, "/d", [], [], [], series);
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
    const out = injectConstants(script, buildConstants(2, "/d", ["a.txt"], [], [1], series));
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

describe("workflow/book-extract.js prompt layout is prompt-cache friendly", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "workflow", "book-extract.js"), "utf8");

  it("serializes the prior-books index once, as a constant frozen for the whole book", () => {
    expect(src).toMatch(/const frozenIndexJson = JSON\.stringify\(startIndex\);/);
    // the growing mid-book additions are kept separately and never spliced into the frozen index
    expect(src).toMatch(/const addedThisBook = \[\];/);
    expect(src).not.toMatch(/index\.push\(/);
  });

  it("orders each chapter prompt as: fixed instructions → frozen index → this-book additions → file path", () => {
    const start = src.indexOf("const extractPrompt = ");
    const body = src.slice(start, src.indexOf("`;", start) + 2);
    const at = (s: string): number => { const i = body.indexOf(s); expect(i, `missing ${s}`).toBeGreaterThan(-1); return i; };
    const fixedTail = at("One row per entity within \"new\""); // last line of the fixed rules
    const frozen = at("${frozenIndexJson}");
    const added = at("${JSON.stringify(addedThisBook)}");
    const path = at("${path}");
    expect(fixedTail).toBeLessThan(frozen);
    expect(frozen).toBeLessThan(added);
    expect(added).toBeLessThan(path);
    // the series rules are fixed text too, so they belong before the frozen index
    expect(at("${seriesRules}")).toBeLessThan(frozen);
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
    expect(body.indexOf("${frozenIndexJson}")).toBeLessThan(body.indexOf("ALIASES LEARNED THIS BOOK"));
    expect(body.indexOf("ALIASES LEARNED THIS BOOK")).toBeLessThan(body.indexOf("${path}"));
  });
  it("tells agents that aliases are names, never descriptive phrases or kinship terms", () => {
    expect(src).toMatch(/NEVER record descriptive phrases/i);
    expect(src).toMatch(/kinship/i);
  });
});
