import { describe, expect, it } from "vitest";
import { buildAliasSupplement, buildMergeMap, synthesizeEarlyDeltas } from "../src/synthesize.js";
import type { Registry, RegistryDelta, RegistryEntity } from "../src/types.js";

function mkEntity(p: Partial<RegistryEntity> & { id: string; canonicalName: string }): RegistryEntity {
  return {
    aliases: [], type: "person", tags: ["in_world"], significance: "minor",
    description: "", firstAppearance: null, appearances: [], ...p,
  };
}

const registry: Registry = {
  booksProcessed: [1, 2, 3],
  entities: [
    mkEntity({
      id: "carl", canonicalName: "Carl", aliases: ["the Crawler"], description: "A crawler.",
      firstAppearance: { anchor: "B1·C1·¶1", snippet: "Carl woke." },
      appearances: ["B1·C1·¶1", "B2·C3·¶5", "B3·C1·¶10"], // spans 1,2,3
    }),
    mkEntity({
      id: "donut", canonicalName: "Princess Donut", description: "A cat.",
      firstAppearance: { anchor: "B2·C1·¶2", snippet: "A cat." },
      appearances: ["B2·C1·¶2"], // introduced in book 2
    }),
    mkEntity({
      id: "mordecai", canonicalName: "Mordecai",
      firstAppearance: { anchor: "B3·C2·¶1", snippet: "Mordecai." },
      appearances: ["B3·C2·¶1"], // book 3 only — must NOT appear in synthesized 1/2
    }),
  ],
};

describe("synthesizeEarlyDeltas", () => {
  it("introduces book-1 entities in delta 1 with only their book-1 anchors", () => {
    const deltas = synthesizeEarlyDeltas(registry, [1, 2]);
    const d1 = deltas[1]!;
    expect(d1.booksProcessed).toEqual([1]);
    const carl = d1.newEntities.find((e) => e.id === "carl")!;
    expect(carl.appearances).toEqual(["B1·C1·¶1"]);
    expect(carl.firstAppearance?.anchor).toBe("B1·C1·¶1");
    expect(carl.description).toBe("A crawler.");
    expect(carl.aliases).toEqual(["the Crawler"]);
    expect(d1.newEntities.map((e) => e.id)).not.toContain("mordecai");
  });

  it("re-mentions a book-1 entity seen again in book 2 as a matched event, not a new entity", () => {
    const deltas = synthesizeEarlyDeltas(registry, [1, 2]);
    const d2 = deltas[2]!;
    expect(d2.booksProcessed).toEqual([1, 2]);
    expect(d2.matched).toContainEqual({ id: "carl", anchor: "B2·C3·¶5", aliases: [] });
    expect(d2.newEntities.map((e) => e.id)).not.toContain("carl");
  });

  it("introduces a book-2-first entity in delta 2", () => {
    const deltas = synthesizeEarlyDeltas(registry, [1, 2]);
    const d2 = deltas[2]!;
    const donut = d2.newEntities.find((e) => e.id === "donut")!;
    expect(donut.appearances).toEqual(["B2·C1·¶2"]);
    expect(donut.firstAppearance?.anchor).toBe("B2·C1·¶2");
  });
});

describe("buildMergeMap", () => {
  const reg: Registry = {
    booksProcessed: [3],
    entities: [mkEntity({ id: "bucket-boy", canonicalName: "Bucket Boy" })],
  };
  const rawDeltas: RegistryDelta[] = [
    {
      booksProcessed: [3], matched: [],
      newEntities: [
        mkEntity({ id: "bucket-boy", canonicalName: "Bucket Boy" }),
        mkEntity({ id: "bucket-boy-2", canonicalName: "Bucket Boy!" }), // dangling newEntity (punctuation variant)
      ],
    },
  ];

  it("maps each dangling newEntity id to its canonical (mergeKey match)", () => {
    expect(buildMergeMap(reg, rawDeltas)).toEqual({ "bucket-boy-2": "bucket-boy" });
  });

  it("drops a matched-only dangling id (never introduced) instead of throwing", () => {
    // Mirrors applyDelta dropping unknown matched ids (e.g. the real 'sam' in book 6).
    const matchedOnly: RegistryDelta[] = [
      { booksProcessed: [3], matched: [{ id: "sam", anchor: "B3·C1·¶1", aliases: [] }], newEntities: [] },
    ];
    expect(buildMergeMap(reg, matchedOnly)).toEqual({}); // "sam" left unmapped, no throw
  });

  it("throws if a dangling newEntity id cannot be resolved to a registry entity", () => {
    const orphan: RegistryDelta[] = [
      { booksProcessed: [3], matched: [], newEntities: [mkEntity({ id: "ghost-2", canonicalName: "Ghost Person" })] },
    ];
    expect(() => buildMergeMap(reg, orphan)).toThrow(/ghost-2/);
  });
});

describe("buildAliasSupplement", () => {
  it("captures registry aliases that folding the deltas would not produce", () => {
    const reg: Registry = {
      booksProcessed: [3],
      entities: [mkEntity({ id: "carl", canonicalName: "Carl", aliases: ["Crawler #4,122", "the Crawler"] })],
    };
    const rawDeltas: RegistryDelta[] = [
      {
        booksProcessed: [3],
        matched: [{ id: "carl", anchor: "B3·C1·¶1", aliases: ["the Crawler"] }],
        newEntities: [],
      },
    ];
    // "Crawler #4,122" is in the registry but never in a delta event -> supplement.
    expect(buildAliasSupplement(reg, rawDeltas, {})).toEqual({ carl: ["Crawler #4,122"] });
  });
});
