import { describe, expect, it } from "vitest";
import { anchorSortKey, dedupe, mergeKey, normalizeAnchor } from "../src/registry.js";
import type { Registry, RegistryEntity } from "../src/types.js";

function mkEntity(partial: Partial<RegistryEntity> & { id: string; canonicalName: string }): RegistryEntity {
  return {
    aliases: [],
    type: "person",
    tags: ["in_world"],
    significance: "minor",
    description: "",
    firstAppearance: null,
    appearances: [],
    ...partial,
  };
}

describe("mergeKey", () => {
  it("collapses case, punctuation, and a leading Crawler prefix", () => {
    expect(mergeKey("Borough Boss")).toBe(mergeKey("Borough boss"));
    expect(mergeKey("Crawler Frank Q")).toBe(mergeKey("Frank Q"));
    expect(mergeKey("Bad Llama")).toBe("bad llama");
  });

  it("does not collapse genuinely different names", () => {
    expect(mergeKey("Goblin Engineer")).not.toBe(mergeKey("Goblin Warlord"));
  });
});

describe("normalizeAnchor", () => {
  it("strips surrounding brackets and whitespace", () => {
    expect(normalizeAnchor("[B1·C1·¶57]")).toBe("B1·C1·¶57");
    expect(normalizeAnchor("  B2·Epigraph·¶3 ")).toBe("B2·Epigraph·¶3");
    expect(normalizeAnchor("B1·Sec55·¶2")).toBe("B1·Sec55·¶2");
  });
});

describe("dedupe normalizes and de-duplicates anchors", () => {
  it("collapses bracketed and clean forms of the same anchor", () => {
    const reg = {
      booksProcessed: [1],
      entities: [
        {
          id: "x",
          canonicalName: "X",
          aliases: [],
          type: "person" as const,
          tags: ["in_world" as const],
          significance: "minor" as const,
          description: "",
          firstAppearance: { anchor: "[B1·C1·¶5]", snippet: "s" },
          appearances: ["[B1·C1·¶5]", "B1·C1·¶5", "B1·C2·¶1"],
        },
      ],
    };
    const { registry: out } = dedupe(reg);
    expect(out.entities[0]?.appearances).toEqual(["B1·C1·¶5", "B1·C2·¶1"]);
    expect(out.entities[0]?.firstAppearance?.anchor).toBe("B1·C1·¶5");
  });
});

describe("anchorSortKey", () => {
  it("orders by book, then section, then paragraph", () => {
    const c10 = anchorSortKey("B1·C10·¶2");
    const c2 = anchorSortKey("B1·C2·¶5");
    const epigraph = anchorSortKey("B1·Epigraph·¶1");
    const epilogue = anchorSortKey("B1·Epilogue·¶3");
    const book2 = anchorSortKey("B2·C1·¶1");
    expect(epigraph).toEqual([1, -4, 1]); // Epigraph before chapters
    expect(c2[1]).toBeLessThan(c10[1]); // C2 before C10
    expect(epilogue[1]).toBeGreaterThan(c10[1]); // Epilogue after chapters
    expect(book2[0]).toBe(2); // book 2
  });
});

describe("dedupe", () => {
  it("merges case/exact/prefix variants and keeps the most-attested name as canonical", () => {
    const registry: Registry = {
      booksProcessed: [1],
      entities: [
        mkEntity({ id: "frank-q", canonicalName: "Frank Q", appearances: ["B1·C5·¶1", "B1·C6·¶2", "B1·C7·¶3"] }),
        mkEntity({
          id: "crawler-frank-q",
          canonicalName: "Crawler Frank Q",
          aliases: ["Franky"],
          significance: "supporting",
          appearances: ["B1·C5·¶1", "B1·C9·¶4"],
        }),
        mkEntity({ id: "bad-llama", canonicalName: "Bad Llama", appearances: ["B1·C8·¶1"] }),
        mkEntity({ id: "bad-llama-2", canonicalName: "Bad llama", appearances: ["B1·C8·¶9"] }),
        mkEntity({ id: "goblin-warlord", canonicalName: "Goblin Warlord", appearances: ["B1·C18·¶1"] }),
      ],
    };
    const { registry: out, merged } = dedupe(registry);
    expect(merged).toBe(2);
    expect(out.entities).toHaveLength(3);

    const frank = out.entities.find((e) => mergeKey(e.canonicalName) === mergeKey("Frank Q"));
    expect(frank?.canonicalName).toBe("Frank Q"); // 3 appearances beats 2
    expect(frank?.aliases).toContain("Crawler Frank Q");
    expect(frank?.aliases).toContain("Franky");
    expect(frank?.significance).toBe("supporting"); // strongest wins
    // de-duplicated + sorted union of appearances
    expect(frank?.appearances).toEqual(["B1·C5·¶1", "B1·C6·¶2", "B1·C7·¶3", "B1·C9·¶4"]);

    expect(out.entities.find((e) => e.canonicalName === "Goblin Warlord")).toBeTruthy();
  });

  it("sorts appearances of non-merged entities too", () => {
    const registry: Registry = {
      booksProcessed: [1],
      entities: [mkEntity({ id: "x", canonicalName: "X", appearances: ["B1·C10·¶1", "B1·C2·¶3"] })],
    };
    const { registry: out } = dedupe(registry);
    expect(out.entities[0]?.appearances).toEqual(["B1·C2·¶3", "B1·C10·¶1"]);
  });
});
