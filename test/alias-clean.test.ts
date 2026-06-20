import { describe, expect, it } from "vitest";
import { isDroppableAlias, isNoiseAlias, isPossessiveOfName, nameFormsOf } from "../src/alias-clean.js";
import type { RegistryEntity } from "../src/types.js";

const ent = (canonicalName: string, aliases: string[]): RegistryEntity => ({
  id: "x", canonicalName, aliases, type: "person", tags: [], significance: "minor",
  description: "", firstAppearance: null, appearances: [],
});

describe("isNoiseAlias (extended)", () => {
  it("drops interrogative/relative words", () => {
    for (const w of ["who", "whom", "whose", "which", "what", "where", "when"]) expect(isNoiseAlias(w)).toBe(true);
  });
  it("still keeps real names", () => {
    expect(isNoiseAlias("Katia")).toBe(false);
  });
});

describe("isPossessiveOfName", () => {
  const forms = ["Katia Grim", "Katia", "Donut"];
  it("drops possessives of a short name form (bare and with object)", () => {
    expect(isPossessiveOfName("Katia's", forms)).toBe(true);
    expect(isPossessiveOfName("Katia's boyfriend", forms)).toBe(true);
    expect(isPossessiveOfName("Donut's tiara", forms)).toBe(true); // curly apostrophe
  });
  it("does not drop epithets or non-possessives", () => {
    expect(isPossessiveOfName("Warlord Katia", forms)).toBe(false);
    expect(isPossessiveOfName("Katia Grim", forms)).toBe(false);
  });
  it("does not drop a legitimate possessive proper-name that is the entity's own name", () => {
    expect(isPossessiveOfName("Hell's Gate", nameFormsOf(ent("Hell's Gate", [])))).toBe(false);
  });
});

describe("isDroppableAlias", () => {
  const katia = ent("Katia Grim", ["Katia"]);
  it("composes noise + possessive", () => {
    expect(isDroppableAlias("who", katia)).toBe(true);
    expect(isDroppableAlias("Katia's map", katia)).toBe(true);
    expect(isDroppableAlias("Crawler Katia Grim", katia)).toBe(false);
  });
});
