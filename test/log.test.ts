import { describe, expect, it } from "vitest";
import { withinCutoff } from "../src/log.js";

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
