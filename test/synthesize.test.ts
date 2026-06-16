import { describe, expect, it } from "vitest";
import { materialize } from "../src/log.js";
import { synthesizeLog } from "../src/synthesize.js";
import type { Registry, RegistryDelta, RegistryEntity } from "../src/types.js";

function mkEntity(p: Partial<RegistryEntity> & { id: string; canonicalName: string }): RegistryEntity {
  return {
    aliases: [], type: "person", tags: ["in_world"], significance: "minor",
    description: "", firstAppearance: null, appearances: [], ...p,
  };
}

const registry: Registry = {
  booksProcessed: [1, 2, 3],
  entities: [
    mkEntity({
      id: "carl", canonicalName: "Carl", aliases: ["the Crawler"], description: "A crawler.",
      firstAppearance: { anchor: "B1·C1·¶1", snippet: "Carl woke." },
      appearances: ["B1·C1·¶1", "B2·C3·¶5", "B3·C1·¶10"],
    }),
    mkEntity({
      id: "donut", canonicalName: "Princess Donut", description: "A cat.",
      firstAppearance: { anchor: "B2·C1·¶2", snippet: "A cat." },
      appearances: ["B2·C1·¶2"],
    }),
    mkEntity({
      id: "mordecai", canonicalName: "Mordecai",
      firstAppearance: { anchor: "B3·C2·¶1", snippet: "Mordecai." },
      appearances: ["B3·C2·¶1"],
    }),
  ],
};

function byBook(reg: Registry): Map<number, RegistryDelta> {
  return new Map(synthesizeLog(reg).map((d): [number, RegistryDelta] => [d.booksProcessed[0] as number, d]));
}

describe("synthesizeLog", () => {
  it("introduces each entity in its earliest-appearance book with that book's anchors", () => {
    const b = byBook(registry);
    const carl = b.get(1)!.newEntities.find((e) => e.id === "carl")!;
    expect(carl.appearances).toEqual(["B1·C1·¶1"]);
    expect(carl.firstAppearance?.anchor).toBe("B1·C1·¶1");
    expect(carl.description).toBe("A crawler.");
    expect(carl.aliases).toEqual(["the Crawler"]);
    expect(b.get(2)!.newEntities.map((e) => e.id)).toContain("donut");
    expect(b.get(3)!.newEntities.map((e) => e.id)).toContain("mordecai");
  });

  it("emits later-book appearances as matched events, not new entities", () => {
    const b = byBook(registry);
    expect(b.get(2)!.matched).toContainEqual({ id: "carl", anchor: "B2·C3·¶5", aliases: [] });
    expect(b.get(3)!.matched).toContainEqual({ id: "carl", anchor: "B3·C1·¶10", aliases: [] });
    expect(b.get(2)!.newEntities.map((e) => e.id)).not.toContain("carl");
  });

  it("introduces at the earliest appearance even when firstAppearance is later (post-dedupe artifact)", () => {
    const reg: Registry = {
      booksProcessed: [5, 6],
      entities: [
        mkEntity({
          id: "annie", canonicalName: "Annie",
          firstAppearance: { anchor: "B6·C1·¶9", snippet: "Annie." }, // later than the earliest appearance
          appearances: ["B6·C1·¶9", "B5·Epilogue·¶139"],
        }),
      ],
    };
    const b = byBook(reg);
    expect(b.get(5)!.newEntities.map((e) => e.id)).toContain("annie");
    expect(b.get(5)!.newEntities[0]!.appearances).toEqual(["B5·Epilogue·¶139"]);
    // and the earlier anchor survives a full round-trip (it is not dropped):
    const full = materialize(synthesizeLog(reg));
    expect(full.entities[0]!.appearances).toEqual(["B5·Epilogue·¶139", "B6·C1·¶9"]);
  });

  it("round-trips through materialize: materialize(synthesizeLog(reg)) reproduces the registry", () => {
    const full = materialize(synthesizeLog(registry));
    expect(full.entities.map((e) => e.id).sort()).toEqual(["carl", "donut", "mordecai"]);
    expect(full.booksProcessed).toEqual([1, 2, 3]);
    const carl = full.entities.find((e) => e.id === "carl")!;
    expect(carl.appearances).toEqual(["B1·C1·¶1", "B2·C3·¶5", "B3·C1·¶10"]);
    expect(carl.aliases).toEqual(["the Crawler"]);
  });
});
