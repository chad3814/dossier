import { describe, expect, it } from "vitest";
import { buildBooksField } from "../src/gen-structure.js";
import type { Registry } from "../src/types.js";

describe("buildBooksField", () => {
  it("emits each processed book's sections in manifest (spine) order", () => {
    const registry = { booksProcessed: [8], entities: [] } as Registry;
    const manifestFor = (book: number) => {
      expect(book).toBe(8);
      return { sections: [{ label: "Epigraph" }, { label: "Interlude" }, { label: "C1" }, { label: "Epilogue" }] };
    };
    expect(buildBooksField(registry, manifestFor)).toEqual([
      { number: 8, sections: ["Epigraph", "Interlude", "C1", "Epilogue"] },
    ]);
  });
});
