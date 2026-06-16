import { describe, expect, it } from "vitest";
import { attachCrawlerNumbers, extractCrawlerNumbers } from "../src/crawler-numbers.js";
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

describe("extractCrawlerNumbers", () => {
  it("parses the broadcast form with curly quotes", () => {
    expect(extractCrawlerNumbers('[B1·C20·¶15] Crawler #324,119. “Frank Q.”')).toEqual([
      { number: "324,119", name: "Frank Q" },
    ]);
  });

  it("parses the second-person designation form (Carl)", () => {
    const text = '[B1·C2·¶32] You have been designated Crawler Number 4,122. You have been assigned the Crawler Name “Carl.”';
    expect(extractCrawlerNumbers(text)).toEqual([{ number: "4,122", name: "Carl" }]);
  });

  it("de-duplicates repeated pairs", () => {
    const text = 'Crawler #7,450. "Agatha." ... Crawler #7,450. "Agatha."';
    expect(extractCrawlerNumbers(text)).toHaveLength(1);
  });
});

describe("attachCrawlerNumbers", () => {
  it("attaches Crawler #IDs to the resolved entities, including partial name matches", () => {
    const registry: Registry = {
      booksProcessed: [1],
      entities: [
        mkEntity({ id: "carl", canonicalName: "Carl" }),
        mkEntity({ id: "frank-q", canonicalName: "Frank Q", aliases: ["Crawler Frank Q"] }),
        mkEntity({ id: "elle-mcgibbons", canonicalName: "Elle McGibbons" }),
      ],
    };
    const texts = [
      'You have been designated Crawler Number 4,122. You have been assigned the Crawler Name “Carl.”',
      'Crawler #324,119. “Frank Q.”',
      'The name over the woman said Crawler #12,330,800. “Elle McGib.”',
    ];
    const { attached } = attachCrawlerNumbers(registry, texts);
    expect(attached).toBe(3);
    expect(registry.entities.find((e) => e.id === "carl")?.aliases).toContain("Crawler #4,122");
    expect(registry.entities.find((e) => e.id === "frank-q")?.aliases).toContain("Crawler #324,119");
    // "Elle McGib" partial-matches "Elle McGibbons"
    expect(registry.entities.find((e) => e.id === "elle-mcgibbons")?.aliases).toContain("Crawler #12,330,800");
  });

  it("does not duplicate an already-present number", () => {
    const registry: Registry = {
      booksProcessed: [1],
      entities: [mkEntity({ id: "agatha", canonicalName: "Agatha", aliases: ["Crawler #7,450"] })],
    };
    const { attached } = attachCrawlerNumbers(registry, ['Crawler #7,450. "Agatha."']);
    expect(attached).toBe(0);
  });
});
