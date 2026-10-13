import { describe, expect, it } from "vitest";
import { buildSectionOrder } from "../src/registry.js";
import { flattenRedescribeResult, mergeBookEvents } from "../src/save-events.js";
import type { AliasEvent, DescriptionEvent } from "../src/types.js";

const d = (id: string, anchor: string): DescriptionEvent => ({ id, anchor, description: "x", significance: "minor" });

describe("flattenRedescribeResult", () => {
  it("accepts the wrapper or bare result and flattens chunked arrays", () => {
    const result = {
      bookNumber: 1,
      descriptionEventChunks: [[d("a", "B1·C1·¶1")], [d("b", "B1·C2·¶1")]],
      aliasEventChunks: [[{ id: "a", anchor: "B1·C1·¶1", alias: "A" }]],
    };
    for (const input of [result, { summary: "s", result }]) {
      const r = flattenRedescribeResult(input);
      expect(r.bookNumber).toBe(1);
      expect(r.descriptionEvents.map((e) => e.id)).toEqual(["a", "b"]);
      expect(r.aliasEvents).toHaveLength(1);
    }
  });
  it("rejects non-results and empty description sets", () => {
    expect(() => flattenRedescribeResult({ foo: 1 })).toThrow(/bookNumber/);
    expect(() => flattenRedescribeResult({ bookNumber: 1, descriptionEventChunks: [] })).toThrow(/no description events/);
  });
});

describe("mergeBookEvents", () => {
  const order = buildSectionOrder([]);
  it("replaces only the given book's events and keeps the log in spine order", () => {
    const existing = [d("a", "B1·C1·¶1"), d("a", "B2·C1·¶1"), d("b", "B1·C3·¶1")];
    const merged = mergeBookEvents(existing, [d("c", "B2·C1·¶9"), d("a", "B2·C2·¶1")], 2, order);
    expect(merged.map((e) => `${e.id}@${e.anchor}`)).toEqual(["a@B1·C1·¶1", "b@B1·C3·¶1", "c@B2·C1·¶9", "a@B2·C2·¶1"]);
  });
  it("is idempotent and works for alias events", () => {
    const al: AliasEvent[] = [{ id: "a", anchor: "B1·C1·¶1", alias: "A" }];
    const once = mergeBookEvents([], al, 1, order);
    expect(mergeBookEvents(once, al, 1, order)).toEqual(once);
  });
});
