import { describe, expect, it } from "vitest";
import { applyCorrections } from "../src/apply-corrections.js";
import type { AliasEvent, DescriptionEvent, Registry } from "../src/types.js";

const ent = (id: string, canonicalName: string, aliases: string[], appearances: string[]) => ({
  id, canonicalName, aliases, type: "person" as const, tags: [], significance: "minor" as const,
  description: "", firstAppearance: null, appearances,
});

function fixture() {
  const registry: Registry = {
    booksProcessed: [1],
    entities: [
      ent("katia", "Katia Grim", ["Katia", "Daniel", "Katia's map", "who"], ["B1·C1·¶1"]),
      ent("tagg", "Epitome Tagg", ["Tagg", "Epitome Tagg's mother"], ["B1·C2·¶1"]),
      ent("noflex", "Epitome Noflex", [], ["B1·C3·¶1"]),
      ent("sexy", "Epitome Tagg's Sexy Mother", [], ["B1·C4·¶1"]),
    ],
  };
  const aliases: AliasEvent[] = [
    { id: "tagg", anchor: "B1·C2·¶1", alias: "Epitome Tagg's mother" },
    { id: "sexy", anchor: "B1·C4·¶1", alias: "Sexy Mum" },
  ];
  const descriptions: DescriptionEvent[] = [
    { id: "sexy", anchor: "B1·C4·¶1", description: "a regal elf", significance: "minor" },
  ];
  return { registry, aliases, descriptions };
}

describe("applyCorrections", () => {
  const corrections = {
    dropAliases: [{ id: "katia", alias: "Daniel" }],
    reassignAliases: [{ from: "tagg", to: "noflex", alias: "Epitome Tagg's mother" }],
    merges: [{ from: "sexy", into: "noflex" }],
  };

  it("cleans the blob, drops, reassigns, and merges", () => {
    const out = applyCorrections({ ...fixture(), corrections });
    const byId = Object.fromEntries(out.registry.entities.map((e) => [e.id, e]));
    // blob cleaning removed possessive + noise; correction removed Daniel
    expect(byId["katia"]!.aliases).toEqual(["Katia"]);
    // reassign moved the alias off tagg and onto noflex (blob + events)
    expect(byId["tagg"]!.aliases).toEqual(["Tagg"]);
    expect(byId["noflex"]!.aliases).toContain("Epitome Tagg's mother");
    expect(out.aliases.find((a) => a.alias === "Epitome Tagg's mother")?.id).toBe("noflex");
    // merge folded sexy into noflex and removed sexy
    expect(byId["sexy"]).toBeUndefined();
    expect(byId["noflex"]!.appearances).toContain("B1·C4·¶1");
    expect(byId["noflex"]!.aliases).toContain("Epitome Tagg's Sexy Mother");
    expect(out.aliases.find((a) => a.alias === "Sexy Mum")?.id).toBe("noflex");
    expect(out.descriptions.find((d) => d.description === "a regal elf")?.id).toBe("noflex");
  });

  it("is idempotent", () => {
    const once = applyCorrections({ ...fixture(), corrections });
    const twice = applyCorrections({ registry: once.registry, aliases: once.aliases, descriptions: once.descriptions, corrections });
    expect(twice).toEqual(once);
  });

  it("does not fold a possessive-of-into alias onto into during merge (idempotency guard)", () => {
    // `from` carries an alias that is a possessive of `into`'s canonicalName.
    // e.g. "Noflex" -> alias "Noflex’s pet" is a possessive of "Noflex".
    // Step-1 blob-clean on a second run would strip it, so it must not be
    // folded onto `into` in the first place.
    const noflex = ent("noflex", "Noflex", [], ["B1·C3·¶1"]);
    const sidekick = ent("sidekick", "Sidekick", ["Noflex’s pet"], ["B1·C5·¶1"]);
    const mergeRegistry: Registry = { booksProcessed: [1], entities: [noflex, sidekick] };
    const mergeCorrections = { merges: [{ from: "sidekick", into: "noflex" }] };

    const once = applyCorrections({
      registry: mergeRegistry,
      aliases: [],
      descriptions: [],
      corrections: mergeCorrections,
    });

    const byId = Object.fromEntries(once.registry.entities.map((e) => [e.id, e]));

    // (a) The possessive alias must NOT appear on `into`
    expect(byId["noflex"]!.aliases).not.toContain("Noflex’s pet");

    // (b) A second run must produce the same output (idempotency)
    const twice = applyCorrections({
      registry: once.registry,
      aliases: once.aliases,
      descriptions: once.descriptions,
      corrections: mergeCorrections,
    });
    expect(twice).toEqual(once);
  });
});
