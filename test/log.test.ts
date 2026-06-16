import { describe, expect, it } from "vitest";
import { materialize, withinCutoff } from "../src/log.js";
import type { RegistryDelta } from "../src/types.js";

describe("withinCutoff", () => {
  it("returns true for every anchor when no cutoff is given", () => {
    expect(withinCutoff("B8·C25·¶64")).toBe(true);
  });

  it("gates by book", () => {
    expect(withinCutoff("B2·C1·¶1", "B3·C1")).toBe(true);
    expect(withinCutoff("B4·C1·¶1", "B3·C1")).toBe(false);
  });

  it("a chapter cutoff includes the whole chapter (paragraph -> infinity)", () => {
    expect(withinCutoff("B2·C4·¶999", "B2·C4")).toBe(true);
    expect(withinCutoff("B2·C5·¶1", "B2·C4")).toBe(false);
  });

  it("a paragraph cutoff is inclusive at the paragraph", () => {
    expect(withinCutoff("B2·C4·¶7", "B2·C4·¶7")).toBe(true);
    expect(withinCutoff("B2·C4·¶8", "B2·C4·¶7")).toBe(false);
  });

  it("orders special sections via anchorSortKey (Prologue before C1, Epilogue after)", () => {
    expect(withinCutoff("B2·Prologue·¶1", "B2·C1")).toBe(true);
    expect(withinCutoff("B2·Epilogue·¶1", "B2·C99")).toBe(false);
  });

  it("normalizes bracketed anchors before comparing", () => {
    expect(withinCutoff("[B2·C1·¶1]", "B2·C1")).toBe(true);
  });
});

function fullEntity(p: Partial<import("../src/types.js").RegistryEntity> & { id: string; canonicalName: string; firstAppearance: { anchor: string; snippet: string } }) {
  return {
    aliases: [], type: "person" as const, tags: ["in_world" as const],
    significance: "minor" as const, description: "", appearances: [], ...p,
  };
}

const deltas: RegistryDelta[] = [
  {
    booksProcessed: [1],
    matched: [],
    newEntities: [
      fullEntity({
        id: "carl", canonicalName: "Carl", aliases: ["the Crawler"], description: "A crawler.",
        firstAppearance: { anchor: "B1·C1·¶1", snippet: "Carl woke." },
        appearances: ["B1·C1·¶1", "B1·C5·¶3"],
      }),
    ],
  },
  {
    booksProcessed: [1, 3],
    matched: [
      { id: "carl", anchor: "B3·C1·¶10", aliases: ["Crawler #4,122"] },
      { id: "bucket-boy-2", anchor: "B3·C2·¶4", aliases: [] }, // dangling id -> merges to bucket-boy
    ],
    newEntities: [
      fullEntity({
        id: "bucket-boy", canonicalName: "Bucket Boy", description: "short",
        firstAppearance: { anchor: "B3·C1·¶1", snippet: "A boy." }, appearances: ["B3·C1·¶1"],
      }),
      fullEntity({
        id: "bucket-boy-2", canonicalName: "The Bucket Boy", description: "a longer description",
        firstAppearance: { anchor: "B3·C2·¶4", snippet: "The boy." }, appearances: ["B3·C2·¶4"],
      }),
    ],
  },
];
const mergeMap = { "bucket-boy-2": "bucket-boy" };

describe("materialize", () => {
  it("folds all events into a registry when no cutoff is given", () => {
    const reg = materialize(deltas, mergeMap);
    expect(reg.booksProcessed).toEqual([1, 3]);
    const carl = reg.entities.find((e) => e.id === "carl")!;
    expect(carl.appearances).toEqual(["B1·C1·¶1", "B1·C5·¶3", "B3·C1·¶10"]);
    expect(carl.aliases).toEqual(expect.arrayContaining(["the Crawler", "Crawler #4,122"]));
  });

  it("merges dangling ids through the merge-map, keeping the longest description", () => {
    const reg = materialize(deltas, mergeMap);
    const ids = reg.entities.map((e) => e.id);
    expect(ids).toContain("bucket-boy");
    expect(ids).not.toContain("bucket-boy-2");
    const bb = reg.entities.find((e) => e.id === "bucket-boy")!;
    expect(bb.appearances).toEqual(["B3·C1·¶1", "B3·C2·¶4"]);
    expect(bb.description).toBe("a longer description");
    expect(bb.aliases).toContain("The Bucket Boy");
  });

  it("gates by reading position: entities introduced after the cutoff are absent, later anchors dropped", () => {
    const reg = materialize(deltas, mergeMap, { upTo: "B1·C99" });
    expect(reg.entities.map((e) => e.id)).toEqual(["carl"]);
    const carl = reg.entities[0]!;
    expect(carl.appearances).toEqual(["B1·C1·¶1", "B1·C5·¶3"]); // no B3 anchor
    expect(carl.aliases).not.toContain("Crawler #4,122"); // B3 alias gated out
  });

  it("sorts entities by canonical name", () => {
    const reg = materialize(deltas, mergeMap);
    expect(reg.entities.map((e) => e.canonicalName)).toEqual(["Bucket Boy", "Carl"]);
  });
});
