import { describe, expect, it } from "vitest";
import {
  applyDelta,
  emptyRegistry,
  foldFindings,
  lookup,
  normalizeName,
  resolveGroup,
  toIndex,
  anchorSortKey,
  buildSectionOrder,
} from "../src/registry.js";
import type { ChapterFindings, Registry, RegistryDelta, RegistryEntity } from "../src/types.js";

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

const registry: Registry = {
  booksProcessed: [1],
  entities: [
    mkEntity({
      id: "princess-donut",
      canonicalName: "Princess Donut",
      aliases: ["Donut", "the cat"],
    }),
    mkEntity({ id: "mordecai", canonicalName: "Mordecai" }),
  ],
};

describe("normalizeName", () => {
  it("lowercases, strips punctuation and apostrophes, collapses spaces", () => {
    expect(normalizeName("  O'Donut, the   GREAT! ")).toBe("odonut the great");
  });
});

describe("lookup", () => {
  it("matches by canonical name (case/punct-insensitive)", () => {
    expect(lookup(registry, "mordecai").map((e) => e.id)).toEqual(["mordecai"]);
  });

  it("matches by alias", () => {
    expect(lookup(registry, "the cat").map((e) => e.id)).toEqual(["princess-donut"]);
    expect(lookup(registry, "Donut").map((e) => e.id)).toEqual(["princess-donut"]);
  });

  it("ranks exact matches ahead of partial matches", () => {
    const hits = lookup(registry, "Donut");
    expect(hits[0]?.id).toBe("princess-donut");
  });

  it("returns nothing for unknown names", () => {
    expect(lookup(registry, "Zaphod")).toEqual([]);
  });
});

describe("applyDelta", () => {
  it("adds new entities and merges matched anchors/aliases onto existing ones", () => {
    const reg: Registry = {
      booksProcessed: [1],
      entities: [mkEntity({ id: "carl", canonicalName: "Carl", appearances: ["B1·C1·¶9"] })],
    };
    const delta: RegistryDelta = {
      booksProcessed: [2],
      matched: [
        { id: "carl", anchor: "[B2·C1·¶3]", aliases: ["Royal Bodyguard Carl"] },
        { id: "carl", anchor: "B2·C1·¶3", aliases: [] }, // dup anchor (bracketed vs clean)
        { id: "ghost", anchor: "B2·C2·¶1", aliases: [] }, // unknown id -> dropped
      ],
      newEntities: [
        mkEntity({ id: "katia", canonicalName: "Katia", appearances: ["B2·C7·¶1", "B2·C7·¶1"] }),
      ],
    };
    const { registry: out, added, appended, dropped } = applyDelta(reg, delta);
    expect(added).toBe(1);
    expect(dropped).toBe(1);
    const carl = out.entities.find((e) => e.id === "carl");
    expect(carl?.appearances).toEqual(["B1·C1·¶9", "B2·C1·¶3"]); // normalized + de-duped
    expect(carl?.aliases).toContain("Royal Bodyguard Carl");
    expect(out.entities.find((e) => e.id === "katia")?.appearances).toEqual(["B2·C7·¶1"]);
    expect(out.booksProcessed).toEqual([1, 2]);
    expect(appended).toBe(1);
  });
});

describe("toIndex", () => {
  it("produces a compact index without descriptions or appearances", () => {
    const idx = toIndex(registry);
    expect(idx[0]).toEqual({
      id: "princess-donut",
      canonicalName: "Princess Donut",
      aliases: ["Donut", "the cat"],
      type: "person",
    });
  });
});

describe("foldFindings", () => {
  it("appends de-duplicated anchors to matched entities and sets first appearance", () => {
    const reg: Registry = {
      booksProcessed: [1],
      entities: [mkEntity({ id: "mordecai", canonicalName: "Mordecai" })],
    };
    const findings: ChapterFindings = {
      matched: [
        { id: "mordecai", anchor: "B1·C3·¶5", snippet: "Mordecai said." },
        { id: "mordecai", anchor: "B1·C3·¶5", snippet: "dup" },
        { id: "mordecai", anchor: "B1·C4·¶1", snippet: "again" },
      ],
      new: [],
    };
    foldFindings(reg, findings);
    const m = reg.entities[0];
    expect(m?.appearances).toEqual(["B1·C3·¶5", "B1·C4·¶1"]);
    expect(m?.firstAppearance).toEqual({ anchor: "B1·C3·¶5", snippet: "Mordecai said." });
  });

  it("enriches a matched entity's aliases with newly-seen name-forms (e.g. Crawler #IDs)", () => {
    const reg: Registry = {
      booksProcessed: [1],
      entities: [mkEntity({ id: "carl", canonicalName: "Carl", aliases: ["the narrator"] })],
    };
    const findings: ChapterFindings = {
      matched: [
        { id: "carl", anchor: "B1·C4·¶2", snippet: "Crawler #4,122", aliases: ["Crawler #4,122"] },
        { id: "carl", anchor: "B1·C9·¶1", snippet: "Carl again", aliases: ["Carl", "the narrator"] },
      ],
      new: [],
    };
    foldFindings(reg, findings);
    const carl = reg.entities[0];
    expect(carl?.aliases).toContain("Crawler #4,122");
    expect(carl?.aliases).toContain("the narrator");
    // self-name and duplicates are not added
    expect(carl?.aliases.filter((a) => a === "Carl")).toHaveLength(0);
    expect(carl?.aliases.filter((a) => a === "the narrator")).toHaveLength(1);
  });

  it("creates new entities with unique ids", () => {
    const reg = emptyRegistry();
    const findings: ChapterFindings = {
      matched: [],
      new: [
        {
          name: "Carl",
          aliases: ["the narrator"],
          type: "person",
          tag: "in_world",
          mentions: [{ anchor: "B1·C1·¶9", snippet: "My name is Carl." }],
        },
        {
          name: "Carl",
          aliases: [],
          type: "other",
          tag: "item_object",
          mentions: [{ anchor: "B1·C2·¶3", snippet: "Carl's Jug." }],
        },
      ],
    };
    foldFindings(reg, findings);
    expect(reg.entities.map((e) => e.id)).toEqual(["carl", "carl-2"]);
    expect(reg.entities[0]?.firstAppearance?.anchor).toBe("B1·C1·¶9");
  });
});

describe("resolveGroup", () => {
  it("resolves a single-member group: cleans aliases/anchors, normalizes first anchor", () => {
    const e = mkEntity({
      id: "carl",
      canonicalName: "Carl",
      aliases: ["Carl", "the Crawler"],
      appearances: ["B1·C2·¶3", "B1·C1·¶1"],
      firstAppearance: { anchor: "[B1·C1·¶1]", snippet: "Carl woke." },
    });
    const r = resolveGroup([e]);
    expect(r.aliases).toEqual(["the Crawler"]); // canonical-equal alias dropped
    expect(r.appearances).toEqual(["B1·C1·¶1", "B1·C2·¶3"]); // sorted, normalized
    expect(r.firstAppearance?.anchor).toBe("B1·C1·¶1");
  });

  it("merges a multi-member group: most-appearances primary, unions aliases/tags, longest desc, max significance", () => {
    const primary = mkEntity({
      id: "bucket-boy",
      canonicalName: "Bucket Boy",
      aliases: ["BB"],
      tags: ["in_world"],
      significance: "minor",
      description: "short",
      appearances: ["B3·C1·¶1", "B3·C2·¶2"],
    });
    const dup = mkEntity({
      id: "bucket-boy-2",
      canonicalName: "The Bucket Boy",
      aliases: ["Crocodilian"],
      tags: ["item_object"],
      significance: "supporting",
      description: "a much longer description",
      appearances: ["B8·C5·¶9"],
    });
    const r = resolveGroup([primary, dup]);
    expect(r.id).toBe("bucket-boy"); // primary = most appearances
    expect(r.canonicalName).toBe("Bucket Boy");
    expect(r.aliases).toEqual(expect.arrayContaining(["BB", "Crocodilian", "The Bucket Boy"]));
    expect(r.tags.sort()).toEqual(["in_world", "item_object"]);
    expect(r.significance).toBe("supporting");
    expect(r.description).toBe("a much longer description");
    expect(r.appearances).toEqual(["B3·C1·¶1", "B3·C2·¶2", "B8·C5·¶9"]);
  });
});

describe("anchorSortKey with SectionOrder", () => {
  const order = buildSectionOrder([
    { number: 8, sections: ["Epigraph", "Interlude", "C1", "Interlude-2", "C2", "Epilogue"] },
  ]);

  it("orders an interlude between its surrounding chapters via the index", () => {
    const c1 = anchorSortKey("B8·C1·¶1", order);
    const inter2 = anchorSortKey("B8·Interlude-2·¶1", order);
    const c2 = anchorSortKey("B8·C2·¶1", order);
    expect(c1[1]).toBeLessThan(inter2[1]);
    expect(inter2[1]).toBeLessThan(c2[1]);
  });

  it("falls back to the label heuristic when no order is given", () => {
    expect(anchorSortKey("B8·C2·¶1")[1]).toBe(2); // C<n> heuristic = n
    expect(anchorSortKey("B8·Interlude·¶1")[1]).toBe(-2); // unchanged heuristic
  });

  it("falls back for a label not present in the index", () => {
    expect(anchorSortKey("B8·Sec999·¶1", order)[1]).toBe(10999); // heuristic Sec
  });
});
