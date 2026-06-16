import { describe, expect, it } from "vitest";
import { buildConstants, injectConstants } from "../src/gen-workflow.js";

describe("buildConstants", () => {
  it("emits a valid constants block with embedded JSON", () => {
    const block = buildConstants(2, "/abs/sections", ["001-C1.txt"], [{ id: "carl" }], [1]);
    expect(block).toContain("const bookNumber = 2;");
    expect(block).toContain('const sectionDir = "/abs/sections";');
    expect(block).toContain('const sectionFiles = ["001-C1.txt"];');
    expect(block).toContain('const startIndex = [{"id":"carl"}];');
    expect(block).toContain("const startBooksProcessed = [1];");
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
    const out = injectConstants(script, buildConstants(2, "/d", ["a.txt"], [], [1]));
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
