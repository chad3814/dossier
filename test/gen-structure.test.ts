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

describe("buildBooksField titles", () => {
  const registry = { booksProcessed: [1, 2], entities: [] } as Registry;
  const manifestFor = () => ({ sections: [{ label: "C1" }] });

  it("merges a title from titleFor when present", () => {
    const titleFor = (b: number) => (b === 2 ? "Carl's Doomsday Scenario" : undefined);
    const out = buildBooksField(registry, manifestFor, titleFor);
    expect(out[1]).toEqual({ number: 2, title: "Carl's Doomsday Scenario", sections: ["C1"] });
  });

  it("omits title when titleFor is absent or returns undefined", () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(buildBooksField(registry, manifestFor)[0]!).toEqual({ number: 1, sections: ["C1"] });
    const out = buildBooksField(registry, manifestFor, () => undefined);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect("title" in out[0]!).toBe(false);
  });
});
