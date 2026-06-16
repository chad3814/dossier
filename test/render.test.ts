import { describe, expect, it } from "vitest";
import { groupAnchors, renderMarkdown } from "../src/render.js";
import type { Registry } from "../src/types.js";

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
