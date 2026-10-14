import { describe, expect, it } from "vitest";
import { buildSectionOrder } from "../src/registry.js";
import { normalizeSignificance, tierFor, tierThresholds } from "../src/normalize-significance.js";
import type { DescriptionEvent, Registry, RegistryEntity } from "../src/types.js";

const ent = (id: string, n: number): RegistryEntity => ({
  id, canonicalName: id, aliases: [], type: "person", tags: ["in_world"], significance: "minor", description: "d",
  firstAppearance: { anchor: "B1·C1·¶1", snippet: "" },
  appearances: Array.from({ length: n }, (_, i) => `B1·C${i + 1}·¶1`),
});
const ev = (id: string, anchor: string, significance: DescriptionEvent["significance"] = "minor"): DescriptionEvent => ({ id, anchor, description: "x", significance });

describe("tierThresholds / tierFor", () => {
  it("ranks by registry-wide totals and caps the major tier near its share", () => {
    const totals = Array.from({ length: 100 }, (_, i) => 100 - i);
    const t = tierThresholds(totals);
    expect(totals.filter((c) => tierFor(c, t) === "major")).toHaveLength(2);
    expect(totals.filter((c) => tierFor(c, t) === "supporting")).toHaveLength(15);
    expect(tierFor(1, t)).toBe("mentioned");
  });
});

describe("normalizeSignificance", () => {
  const registry: Registry = { booksProcessed: [1], entities: [ent("hero", 40), ent("side", 10), ...Array.from({ length: 98 }, (_, i) => ent(`x${i}`, 1))], books: [] };
  const order = buildSectionOrder([]);

  it("grows with the reader's position and ignores the agent's original rating", () => {
    const out = normalizeSignificance([ev("hero", "B1·C1·¶1", "major"), ev("hero", "B1·C40·¶1", "minor"), ev("x0", "B1·C1·¶1", "major")], registry, order);
    const at = (id: string, anchor: string) => out.find((e) => e.id === id && e.anchor === anchor)?.significance;
    expect(at("hero", "B1·C1·¶1")).not.toBe("major");
    expect(at("hero", "B1·C40·¶1")).toBe("major");
    expect(at("x0", "B1·C1·¶1")).not.toBe("major");
  });
  it("never decreases along an entity's events and leaves unknown ids alone", () => {
    const events = Array.from({ length: 40 }, (_, i) => ev("hero", `B1·C${i + 1}·¶1`));
    const rank = { mentioned: 0, minor: 1, supporting: 2, major: 3 };
    const sigs = normalizeSignificance(events, registry, order).map((e) => rank[e.significance]);
    expect(sigs).toEqual([...sigs].sort((a, b) => a - b));
    const ghost = ev("ghost", "B1·C1·¶1", "supporting");
    expect(normalizeSignificance([ghost], registry, order)).toEqual([ghost]);
  });

  it("adds a copy of the latest description where an entity crosses into a higher tier after its last event", () => {
    const t = tierThresholds(registry.entities.map((e) => e.appearances.length));
    const first = { ...ev("hero", "B1·C1·¶1"), description: "Hero, introduced." };
    const out = normalizeSignificance([first], registry, order).filter((e) => e.id === "hero");
    const major = out.find((e) => e.significance === "major");
    expect(major?.anchor).toBe(`B1·C${t.major}·¶1`);
    expect(major?.description).toBe("Hero, introduced.");
    expect(out.map((e) => e.anchor)).toEqual([...out.map((e) => e.anchor)].sort((a, b) => Number(a.match(/C(\d+)/)?.[1]) - Number(b.match(/C(\d+)/)?.[1])));
  });
  it("does not add a crossing event where one already exists at that appearance", () => {
    const t = tierThresholds(registry.entities.map((e) => e.appearances.length));
    const out = normalizeSignificance([ev("hero", "B1·C1·¶1"), ev("hero", `B1·C${t.major}·¶1`)], registry, order);
    expect(out.filter((e) => e.anchor === `B1·C${t.major}·¶1`)).toHaveLength(1);
  });
});
