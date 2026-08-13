import { describe, expect, it } from "vitest";
import { correctionIdMap, resolveHistoricalId } from "../src/id-history.js";
import { reconcileAliases } from "../src/reconcile-aliases.js";
import type { Registry, RegistryEntity } from "../src/types.js";

const registry: Registry = {
  booksProcessed: [1],
  entities: [{
    id: "katia", canonicalName: "Katia Grim", aliases: ["Katia"], type: "person", tags: [],
    significance: "major", description: "", firstAppearance: null, appearances: ["B1·C1·¶1"],
  }],
};

/** Minimal entity helper for the id-history tests. */
function entity(id: string, canonicalName: string, aliases: string[], appearances: string[]): RegistryEntity {
  return {
    id, canonicalName, aliases, type: "person", tags: [],
    significance: "supporting", description: "", firstAppearance: null, appearances,
  };
}

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

describe("correctionIdMap", () => {
  it("maps both renameIds and merge sources to their targets", () => {
    const map = correctionIdMap({
      renameIds: [{ from: "eva-2", to: "eva" }],
      merges: [{ from: "parvati", into: "alexandro" }],
    });
    expect(map.get("eva-2")).toBe("eva");
    expect(map.get("parvati")).toBe("alexandro");
  });
});

describe("resolveHistoricalId", () => {
  const current = new Set(["eva", "alexandro"]);

  it("returns the id unchanged when it is already current", () => {
    expect(resolveHistoricalId("eva", current, new Map([["eva", "someone-else"]]))).toBe("eva");
  });

  it("follows a rename to the current id", () => {
    expect(resolveHistoricalId("eva-2", current, new Map([["eva-2", "eva"]]))).toBe("eva");
  });

  it("follows a rename-then-merge chain", () => {
    const map = new Map([["parvati-2", "parvati"], ["parvati", "alexandro"]]);
    expect(resolveHistoricalId("parvati-2", current, map)).toBe("alexandro");
  });

  it("returns null for an id that cannot be resolved", () => {
    expect(resolveHistoricalId("ghost", current, new Map())).toBeNull();
  });

  it("returns null instead of looping on a cyclic map", () => {
    const map = new Map([["a", "b"], ["b", "a"]]);
    expect(resolveHistoricalId("a", current, map)).toBeNull();
  });
});

describe("reconcileAliases resolves historical event ids", () => {
  it("keeps a renamed entity's alias at its original early anchor", () => {
    const reg: Registry = {
      booksProcessed: [3],
      entities: [entity("eva", "Eva", ["Eva Sigrid"], ["B3·C21·¶14", "B7·C47·¶21"])],
    };
    const out = reconcileAliases(
      reg,
      [{ id: "eva-2", anchor: "B3·C21·¶14", alias: "Eva Sigrid" }],
      new Map([["eva-2", "eva"]]),
    );
    expect(out).toEqual([{ id: "eva", anchor: "B3·C21·¶14", alias: "Eva Sigrid" }]);
  });

  it("remaps a merged entity's alias events onto the merge target", () => {
    const reg: Registry = {
      booksProcessed: [7],
      entities: [entity("alexandro", "Alexandro", ["number 21"], ["B5·C37·¶76", "B7·C72·¶31"])],
    };
    const out = reconcileAliases(
      reg,
      [{ id: "parvati", anchor: "B6·Epilogue·¶23", alias: "number 21" }],
      new Map([["parvati", "alexandro"]]),
    );
    expect(out).toEqual([{ id: "alexandro", anchor: "B6·Epilogue·¶23", alias: "number 21" }]);
  });

  it("does not redirect an id that still exists in the registry", () => {
    const reg: Registry = {
      booksProcessed: [1],
      entities: [
        entity("tipid", "Tipid", ["the goat"], ["B1·C1·¶1"]),
        entity("tipid-2", "Tipid Two", ["the other goat"], ["B1·C2·¶1"]),
      ],
    };
    const out = reconcileAliases(
      reg,
      [{ id: "tipid-2", anchor: "B1·C2·¶1", alias: "the other goat" }],
      new Map([["tipid-2", "tipid"]]),
    );
    expect(out).toContainEqual({ id: "tipid-2", anchor: "B1·C2·¶1", alias: "the other goat" });
  });

  it("drops an event whose id resolves to nothing", () => {
    const reg: Registry = {
      booksProcessed: [1],
      entities: [entity("carl", "Carl", [], ["B1·C1·¶1"])],
    };
    const out = reconcileAliases(reg, [{ id: "ghost", anchor: "B1·C1·¶1", alias: "spooky" }]);
    expect(out).toEqual([]);
  });
});
