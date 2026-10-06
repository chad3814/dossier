import { describe, expect, it } from "vitest";
import { flattenWorkflowResult, validateDelta } from "../src/save-delta.js";
import type { RegistryEntity } from "../src/types.js";

const ent = (id: string, appearances: string[]): RegistryEntity => ({
  id, canonicalName: id, aliases: [], type: "person", tags: ["in_world"], significance: "minor",
  description: "d", firstAppearance: { anchor: appearances[0]!, snippet: "" }, appearances,
});

describe("flattenWorkflowResult", () => {
  it("accepts the runner's wrapper or a bare result, flattens chunked arrays, and strips anchor brackets", () => {
    const result = {
      booksProcessed: [1, 2],
      matchedChunks: [[{ id: "a", anchor: "[B2·C1·¶3]", aliases: [] }], [{ id: "b", anchor: "B2·C2·¶1", aliases: ["Bee"] }]],
      newEntityChunks: [[ent("c", ["[B2·C3·¶1]", "B2·C3·¶4"])]],
    };
    for (const input of [result, { summary: "x", result }]) {
      const d = flattenWorkflowResult(input);
      expect(d.booksProcessed).toEqual([1, 2]);
      expect(d.matched).toEqual([{ id: "a", anchor: "B2·C1·¶3", aliases: [] }, { id: "b", anchor: "B2·C2·¶1", aliases: ["Bee"] }]);
      expect(d.newEntities[0]!.appearances).toEqual(["B2·C3·¶1", "B2·C3·¶4"]);
      expect(d.newEntities[0]!.firstAppearance!.anchor).toBe("B2·C3·¶1");
    }
  });
  it("also accepts the pre-chunking shape (matched / newEntities)", () => {
    const d = flattenWorkflowResult({ booksProcessed: [1], matched: [{ id: "a", anchor: "B1·C1·¶1", aliases: [] }], newEntities: [] });
    expect(d.matched.length).toBe(1);
  });
  it("rejects anything else", () => {
    expect(() => flattenWorkflowResult({ nope: true })).toThrow(/not a workflow extraction result/);
  });
});

describe("validateDelta", () => {
  const sections = "### B2·C1\n[B2·C1·¶1] Hello.\n[B2·C1·¶2] World.\n";
  it("reports anchors not present in the section text, unknown matched ids, duplicate new ids, and id collisions", () => {
    const d = {
      booksProcessed: [1, 2],
      matched: [{ id: "known", anchor: "B2·C1·¶1", aliases: [] }, { id: "ghost", anchor: "B2·C1·¶9", aliases: [] }],
      newEntities: [ent("x", ["B2·C1·¶2"]), ent("x", ["B2·C1·¶2"]), ent("known", ["B2·C1·¶1"])],
    };
    const r = validateDelta(d, sections, new Set(["known"]));
    expect(r.book).toBe(2);
    expect(r.badAnchors).toEqual(["B2·C1·¶9"]);
    expect(r.unknownMatchedIds).toEqual(["ghost"]);
    expect(r.duplicateNewIds).toEqual(["x"]);
    expect(r.collidingNewIds).toEqual(["known"]);
    expect(r.ok).toBe(false);
  });
  it("is ok for a clean delta and counts mentions matched to prior entities", () => {
    const d = { booksProcessed: [1, 2], matched: [{ id: "known", anchor: "B2·C1·¶1", aliases: [] }], newEntities: [ent("x", ["B2·C1·¶2"])] };
    const r = validateDelta(d, sections, new Set(["known"]));
    expect(r.ok).toBe(true);
    expect(r.matchedToPrior).toBe(1);
  });
});
