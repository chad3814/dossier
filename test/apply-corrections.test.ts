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

  it("renameIds changes the entity id and remaps alias + description events", () => {
    const { registry, aliases, descriptions } = fixture();
    const out = applyCorrections({
      registry,
      aliases,
      descriptions,
      corrections: { renameIds: [{ from: "sexy", to: "sexy-canonical" }] },
    });
    const byId = Object.fromEntries(out.registry.entities.map((e) => [e.id, e]));
    // old id gone, new id present
    expect(byId["sexy"]).toBeUndefined();
    expect(byId["sexy-canonical"]).toBeDefined();
    // alias event remapped
    expect(out.aliases.find((a) => a.alias === "Sexy Mum")?.id).toBe("sexy-canonical");
    // description event remapped
    expect(out.descriptions.find((d) => d.description === "a regal elf")?.id).toBe("sexy-canonical");
  });

  it("renameIds runs before dropAliases (post-rename id is honored by drop)", () => {
    const { registry, aliases, descriptions } = fixture();
    const out = applyCorrections({
      registry,
      aliases,
      descriptions,
      corrections: {
        renameIds: [{ from: "sexy", to: "sexy-canonical" }],
        // drop the alias event that was recorded under the NEW id
        dropAliases: [{ id: "sexy-canonical", alias: "Sexy Mum" }],
      },
    });
    // alias event for "Sexy Mum" must be absent (dropped after rename)
    expect(out.aliases.find((a) => a.alias === "Sexy Mum")).toBeUndefined();
  });

  it("renameIds is idempotent (second run equals first)", () => {
    const renameCorrections = { renameIds: [{ from: "sexy", to: "sexy-canonical" }] };
    const once = applyCorrections({ ...fixture(), corrections: renameCorrections });
    const twice = applyCorrections({
      registry: once.registry,
      aliases: once.aliases,
      descriptions: once.descriptions,
      corrections: renameCorrections,
    });
    expect(twice).toEqual(once);
  });

  it("renameIds skips the pair when the target id already exists (no rename, no clobber)", () => {
    const { registry, aliases, descriptions } = fixture();
    // "katia" and "tagg" both exist; renaming katia->tagg must be a no-op
    const out = applyCorrections({
      registry,
      aliases,
      descriptions,
      corrections: { renameIds: [{ from: "katia", to: "tagg" }] },
    });
    const byId = Object.fromEntries(out.registry.entities.map((e) => [e.id, e]));
    // Both entities must still be present and unchanged
    expect(byId["katia"]).toBeDefined();
    expect(byId["tagg"]).toBeDefined();
    // tagg's canonicalName must not have changed to katia's
    expect(byId["tagg"]!.canonicalName).toBe("Epitome Tagg");
    expect(byId["katia"]!.canonicalName).toBe("Katia Grim");
  });

  it("merge sorts interleaved appearances into canonical anchorSortKey order", () => {
    // into: B1·C1·¶1, B3·C2·¶1  from: B2·C1·¶1
    // append order would give B1·C1·¶1, B3·C2·¶1, B2·C1·¶1 — wrong
    // canonical order: B1·C1·¶1, B2·C1·¶1, B3·C2·¶1
    const intoEnt = ent("into-char", "Into Char", [], ["B1·C1·¶1", "B3·C2·¶1"]);
    const fromEnt = ent("from-char", "From Char", [], ["B2·C1·¶1"]);
    const mergeRegistry: Registry = { booksProcessed: [1], entities: [intoEnt, fromEnt] };
    const mergeCorrections = { merges: [{ from: "from-char", into: "into-char" }] };

    const out = applyCorrections({
      registry: mergeRegistry,
      aliases: [],
      descriptions: [],
      corrections: mergeCorrections,
    });

    const byId = Object.fromEntries(out.registry.entities.map((e) => [e.id, e]));
    expect(byId["into-char"]!.appearances).toEqual(["B1·C1·¶1", "B2·C1·¶1", "B3·C2·¶1"]);
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
