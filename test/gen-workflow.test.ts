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
