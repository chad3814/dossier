import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCorrections, readJsonArrayIfExists } from "../src/apply-corrections.js";
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

  it("applies a dropAliases op whose id was already merged away, onto the merge target", () => {
    // Replaying corrections.json against already-corrected data: `ghost` is gone (merged into
    // `host` by an earlier run) and its aliases now live on `host`. A drop keyed to the old id
    // must still take effect, or a deliberately-dropped alias silently comes back.
    const registry: Registry = {
      booksProcessed: [1],
      entities: [ent("host", "Host", ["keeper", "crawler"], ["B1·C1·¶1", "B1·C2·¶1"])],
    };
    const corrections = {
      dropAliases: [{ id: "ghost", alias: "crawler" }],
      merges: [{ from: "ghost", into: "host" }],
    };

    const out = applyCorrections({ registry, aliases: [], descriptions: [], corrections });
    const host = out.registry.entities.find((e) => e.id === "host");

    expect(host?.aliases).toContain("keeper");
    expect(host?.aliases).not.toContain("crawler");
  });

  it("applies a reassignAliases op whose endpoints were already merged away", () => {
    const registry: Registry = {
      booksProcessed: [1],
      entities: [
        ent("host", "Host", ["the visitor"], ["B1·C1·¶1"]),
        ent("target", "Target", [], ["B1·C2·¶1"]),
      ],
    };
    const corrections = {
      reassignAliases: [{ from: "ghost", to: "target", alias: "the visitor" }],
      merges: [{ from: "ghost", into: "host" }],
    };

    const out = applyCorrections({
      registry,
      aliases: [{ id: "ghost", anchor: "B1·C1·¶1", alias: "the visitor" }],
      descriptions: [],
      corrections,
    });
    const byId = Object.fromEntries(out.registry.entities.map((e) => [e.id, e]));

    expect(byId["host"]!.aliases).not.toContain("the visitor");
    expect(byId["target"]!.aliases).toContain("the visitor");
    expect(out.aliases).toEqual([{ id: "target", anchor: "B1·C1·¶1", alias: "the visitor" }]);
  });
});

describe("readJsonArrayIfExists", () => {
  it("returns null for a missing file (pre-redescribe series) and the parsed array otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "corr-"));
    expect(readJsonArrayIfExists(join(dir, "nope.json"))).toBeNull();
    writeFileSync(join(dir, "aliases.json"), JSON.stringify([{ id: "a", anchor: "B1·C1·¶1", alias: "A" }]), "utf8");
    expect(readJsonArrayIfExists(join(dir, "aliases.json"))).toEqual([{ id: "a", anchor: "B1·C1·¶1", alias: "A" }]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("aliasPolicy and setCanonical", () => {
  const mkE = (id: string, canonicalName: string, aliases: string[], appearances: string[] = ["B1·C1·¶1"]) => ({
    id, canonicalName, aliases, type: "person" as const, tags: ["in_world" as const], significance: "minor" as const,
    description: "", firstAppearance: { anchor: appearances[0]!, snippet: "" }, appearances,
  });

  it("names-only policy scrubs descriptive aliases during blob-clean; default policy leaves them", () => {
    const registry: Registry = { booksProcessed: [1], entities: [mkE("elspeth", "Elspeth Arella", ["the director", "Madam Director", "the woman", "Arella"])] };
    const scrubbed = applyCorrections({ registry, aliases: [], descriptions: [], corrections: {}, aliasPolicy: "names-only" });
    expect(scrubbed.registry.entities[0]!.aliases).toEqual(["Madam Director", "Arella"]);
    const kept = applyCorrections({ registry, aliases: [], descriptions: [], corrections: {} });
    expect(kept.registry.entities[0]!.aliases).toEqual(["the director", "Madam Director", "the woman", "Arella"]);
  });

  it("setCanonical renames the display name after merges and keeps the old name as an alias", () => {
    const registry: Registry = {
      booksProcessed: [1],
      entities: [
        mkE("lady-vane", "Lady Vane", ["milady"], ["B1·C9·¶26"]),
        mkE("cressida", "Cressida", ["Cressida Vane"], ["B1·C12·¶35"]),
      ],
    };
    const out = applyCorrections({
      registry, aliases: [], descriptions: [],
      corrections: { merges: [{ from: "lady-vane", into: "cressida" }], setCanonical: [{ id: "cressida", canonicalName: "Cressida Vane" }] },
    });
    const c = out.registry.entities.find((e) => e.id === "cressida")!;
    expect(out.registry.entities.map((e) => e.id)).toEqual(["cressida"]);
    expect(c.canonicalName).toBe("Cressida Vane");
    expect(c.aliases).toEqual(expect.arrayContaining(["Cressida", "Lady Vane", "milady"]));
    expect(c.aliases).not.toContain("Cressida Vane"); // canonical is not also an alias
  });

  it("setCanonical on a missing id is a no-op (idempotent-on-missing like every other op)", () => {
    const registry: Registry = { booksProcessed: [1], entities: [mkE("a", "A", [])] };
    expect(() => applyCorrections({ registry, aliases: [], descriptions: [], corrections: { setCanonical: [{ id: "ghost", canonicalName: "G" }] } })).not.toThrow();
  });
});

describe("merge never adds an alias equal to the surviving entity's canonical name", () => {
  it("skips from-aliases (and from's canonical) that normalize to into.canonicalName, so materialize round-trips", () => {
    const mkE = (id: string, canonicalName: string, aliases: string[], appearances: string[]) => ({
      id, canonicalName, aliases, type: "person" as const, tags: ["in_world" as const], significance: "minor" as const,
      description: "", firstAppearance: { anchor: appearances[0]!, snippet: "" }, appearances,
    });
    const registry: Registry = {
      booksProcessed: [1],
      entities: [
        mkE("humphrey", "Humphrey", ["Humphrey Geller"], ["B1·C45·¶61"]),
        mkE("danielle-gellers-son", "Danielle Geller's son", ["Humphrey", "humphrey", "Young Master Geller"], ["B1·C37·¶26"]),
      ],
    };
    const out = applyCorrections({ registry, aliases: [], descriptions: [], corrections: { merges: [{ from: "danielle-gellers-son", into: "humphrey" }] } });
    const h = out.registry.entities.find((e) => e.id === "humphrey")!;
    expect(h.aliases).toEqual(["Humphrey Geller", "Young Master Geller", "Danielle Geller's son"]);
  });
});

describe("applyCorrections keeps entities sorted by canonical name", () => {
  it("re-sorts after setCanonical so materialize(synthesizeLog(registry)) reproduces entity order", () => {
    const mkE = (id: string, canonicalName: string) => ({
      id, canonicalName, aliases: [], type: "person" as const, tags: ["in_world" as const], significance: "minor" as const,
      description: "", firstAppearance: { anchor: "B1·C1·¶1", snippet: "" }, appearances: ["B1·C1·¶1"],
    });
    const registry: Registry = { booksProcessed: [1], entities: [mkE("alpha", "Alpha"), mkE("jasons-familiar", "Jason's familiar"), mkE("zed", "Zed")] };
    const out = applyCorrections({ registry, aliases: [], descriptions: [], corrections: { setCanonical: [{ id: "jasons-familiar", canonicalName: "Colin" }] } });
    expect(out.registry.entities.map((e) => e.canonicalName)).toEqual(["Alpha", "Colin", "Zed"]);
    // and a rename that should move it to the end
    const out2 = applyCorrections({ registry, aliases: [], descriptions: [], corrections: { setCanonical: [{ id: "jasons-familiar", canonicalName: "Zorro" }] } });
    expect(out2.registry.entities.map((e) => e.canonicalName)).toEqual(["Alpha", "Zed", "Zorro"]);
  });
});

describe("setType", () => {
  const mk = (id: string, type: "person" | "other") => ({
    id, canonicalName: id, aliases: [], type, tags: ["in_world" as const], significance: "minor" as const,
    description: "", firstAppearance: { anchor: "B1·C1·¶1", snippet: "" }, appearances: ["B1·C1·¶1"],
  });
  it("reclassifies the entity, is idempotent, and ignores missing ids", () => {
    const registry: Registry = { booksProcessed: [1], entities: [mk("the-builder", "other"), mk("jason", "person")] };
    const corrections = { setType: [{ id: "the-builder", type: "person" as const }, { id: "ghost", type: "person" as const }] };
    const once = applyCorrections({ registry, aliases: [], descriptions: [], corrections });
    expect(once.registry.entities.map((e) => [e.id, e.type])).toEqual([["jason", "person"], ["the-builder", "person"]]);
    const twice = applyCorrections({ registry: once.registry, aliases: [], descriptions: [], corrections });
    expect(twice.registry).toEqual(once.registry);
  });
});
