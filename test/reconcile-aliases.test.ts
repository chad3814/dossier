import { describe, expect, it } from "vitest";
import { reconcileAliases } from "../src/reconcile-aliases.js";
import type { Registry } from "../src/types.js";

const registry: Registry = {
  booksProcessed: [1],
  entities: [{
    id: "katia", canonicalName: "Katia Grim", aliases: ["Katia"], type: "person", tags: [],
    significance: "major", description: "", firstAppearance: null, appearances: ["B1·C1·¶1"],
  }],
};

describe("reconcileAliases drops possessives", () => {
  it("removes a possessive-of-name event and bare 'who'", () => {
    const out = reconcileAliases(registry, [
      { id: "katia", anchor: "B1·C1·¶1", alias: "Katia's map" },
      { id: "katia", anchor: "B1·C1·¶2", alias: "who" },
      { id: "katia", anchor: "B1·C1·¶3", alias: "Katia Prime" },
    ]);
    const aliases = out.filter((e) => e.id === "katia").map((e) => e.alias);
    expect(aliases).not.toContain("Katia's map");
    expect(aliases).not.toContain("who");
    expect(aliases).toContain("Katia Prime");
  });
});
