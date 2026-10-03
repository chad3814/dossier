import { describe, expect, it } from "vitest";
import { earliestAppearance, groupAnchors, parseRenderArgs, renderMarkdown } from "../src/render.js";
import { buildSectionOrder } from "../src/registry.js";
import type { Registry } from "../src/types.js";

describe("earliestAppearance uses spine order", () => {
  it("picks the section that comes first in the manifest, not the label heuristic", () => {
    const order = buildSectionOrder([{ number: 8, sections: ["Interlude", "C1", "Interlude-2", "C2"] }]);
    // Interlude-2 (spine idx 2) precedes C2 (idx 3) even though heuristic would rank C2 earlier.
    expect(earliestAppearance(["B8·C2·¶1", "B8·Interlude-2·¶1"], order)).toBe("B8·Interlude-2·¶1");
  });
});

describe("groupAnchors", () => {
  it("collapses consecutive anchors per section, grouped by book", () => {
    expect(groupAnchors(["B1·C1·¶1", "B1·C1·¶4", "B1·C2·¶3", "B2·C1·¶2"])).toBe(
      "B1 · C1 ¶1, 4 · C2 ¶3  ||  B2 · C1 ¶2",
    );
  });

  it("handles a single anchor", () => {
    expect(groupAnchors(["B1·C5·¶9"])).toBe("B1 · C5 ¶9");
  });
});

describe("renderMarkdown", () => {
  const registry: Registry = {
    booksProcessed: [1],
    entities: [
      {
        id: "princess-donut",
        canonicalName: "Princess Donut",
        type: "creature",
        aliases: ["Donut", "the cat"],
        tags: ["in_world"],
        significance: "major",
        description: "Carl's ex-girlfriend's show cat, now a sapient crawler.",
        firstAppearance: { anchor: "B1·C1·¶3", snippet: "The cat yowled." },
        appearances: ["B1·C1·¶3", "B1·C1·¶8", "B1·C2·¶1"],
      },
      {
        id: "mordecai",
        canonicalName: "Mordecai",
        type: "person",
        aliases: [],
        tags: ["in_world"],
        significance: "supporting",
        description: "A rat-creature guildmaster.",
        firstAppearance: { anchor: "B1·C3·¶5", snippet: "Mordecai said." },
        appearances: ["B1·C3·¶5"],
      },
    ],
  };

  it("includes title, tag breakdown, index links, and entities sorted by significance", () => {
    const md = renderMarkdown(registry);
    expect(md).toContain("# Dungeon Crawler Carl — Character Compendium");
    expect(md).toContain("Book(s) 1");
    expect(md).toContain("[Princess Donut](#princess-donut)");
    expect(md).toContain("### Princess Donut");
    expect(md).toContain("**Also known as:** Donut, the cat");
    expect(md).toContain("in_world");
    expect(md).toContain('**First appears:** `B1·C1·¶3` — "The cat yowled."');
    expect(md).toContain("**Appears:** B1 · C1 ¶3, 8 · C2 ¶1");
    expect(md.indexOf("### Princess Donut")).toBeLessThan(md.indexOf("### Mordecai"));
  });
});

describe("parseRenderArgs", () => {
  it("accepts no args or a single --out <path>", () => {
    expect(parseRenderArgs([])).toEqual({});
    expect(parseRenderArgs(["--out", "x.md"])).toEqual({ out: "x.md" });
  });

  it("rejects a valueless --out or a flag-shaped value", () => {
    expect(() => parseRenderArgs(["--out"])).toThrow(/--out requires a value/);
    expect(() => parseRenderArgs(["--out", "--series"])).toThrow(/--out requires a value/);
  });

  it("rejects stray positionals and unknown flags (the old [in] [out] form)", () => {
    expect(() => parseRenderArgs(["output/registry.json"])).toThrow(/unexpected argument "output\/registry.json"/);
    expect(() => parseRenderArgs(["--out", "x.md", "extra.md"])).toThrow(/unexpected argument "extra.md"/);
    expect(() => parseRenderArgs(["--format", "md"])).toThrow(/unexpected argument "--format"/);
  });
});
