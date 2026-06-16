# Log-entry Revision (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a position-gated event log the source of truth for the character compendium: `materialize(deltas, mergeMap, {upTo})` replays per-book deltas to a reading position and derives the registry, with the full-series materialization reproducing the committed `registry.json` exactly.

**Architecture:** Reuse the existing per-book deltas (books 3–8) untouched; synthesize books 1–2 deltas deterministically from `registry.json`; freeze a `dedupe` merge-map (id → canonical id) plus a tiny alias supplement (residue from the `crawler-numbers` pass). `materialize` folds gated events into raw entities, groups them by the frozen merge-map, and resolves each group with the *same* field logic `dedupe` uses (factored into a shared `resolveGroup`). The flat `registry.json` becomes a derived, test-reproduced artifact. Descriptions remain single blobs in Phase 1 (per-chapter versioned descriptions are Phase 2).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `tsx`, `vitest`. All Phase-1 work is deterministic — no agents, no EPUBs.

**Spec:** `docs/superpowers/specs/2026-06-16-log-entry-revision-design.md`

**Working directory:** all paths are relative to the `dossier/` repo root (the submodule). DCC data lives in the sibling `../dcc/` (the `casefiles` umbrella). Run all commands from `dossier/`.

**Reproduction note (planning discovery vs. spec):** the spec names one frozen reconciliation artifact (`merge-map.json`). Implementation adds a second, `alias-supplement.json` — currently a single entry (one `Crawler #` alias the `crawler-numbers` pass added beyond the delta events). It's the same idea as the merge-map (a frozen lens applied at fold time) and is required for exact reproduction without re-reading EPUB text.

---

## File Structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `src/types.ts` | Add `MergeMap`, `AliasSupplement`, `Cutoff` type aliases | Modify |
| `src/registry.ts` | Extract `resolveGroup` from `dedupe`, export it; `dedupe` calls it | Modify |
| `src/log.ts` | `withinCutoff` gating + `materialize` (the pure fold/gate/group function) | Create |
| `src/migrate-to-log.ts` | One-time migration: synthesize 1–2, build+verify merge-map & alias-supplement, write artifacts | Create |
| `src/view.ts` | CLI: read the log from `../dcc`, `materialize` at an optional cutoff, `render` | Create |
| `src/synthesize.ts` | `synthesizeEarlyDeltas`, `buildMergeMap`, `buildAliasSupplement` (pure migration helpers) | Create |
| `test/log.test.ts` | Unit tests for `withinCutoff` + `materialize` (synthetic data) | Create |
| `test/synthesize.test.ts` | Unit tests for the migration helpers (synthetic data) | Create |
| `test/registry.test.ts` | Add `resolveGroup` tests | Modify |
| `test/migration-repro.test.ts` | Guarded integration test: full materialize === `../dcc/output/registry.json` | Create |
| `package.json` | Add `migrate-to-log` and `view` scripts | Modify |

---

## Task 1: Add log type aliases

**Files:**
- Modify: `src/types.ts` (append at end)

- [ ] **Step 1: Add the types**

Append to `src/types.ts`:

```ts
/** A reading-position cutoff anchor, e.g. "B2·C4" (whole chapter) or "B2·C4·¶7". */
export type Cutoff = string;

/** Frozen id → canonical-id map capturing dedupe merges, applied at materialize time. */
export type MergeMap = Record<string, string>;

/** Frozen extra aliases (keyed by canonical id) added by post-passes beyond the delta log. */
export type AliasSupplement = Record<string, string[]>;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no output, exit 0).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "types: add Cutoff, MergeMap, AliasSupplement for the log model"
```

---

## Task 2: Extract `resolveGroup` from `dedupe`

`dedupe` currently inlines its group→entity resolution. `materialize` needs the *identical* logic (so a frozen-map grouping reproduces `dedupe`'s output). Factor it into one exported function used by both.

**Files:**
- Modify: `src/registry.ts:234-293` (the `dedupe` function)
- Test: `test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/registry.test.ts` (import `resolveGroup` in the existing import block from `../src/registry.js`):

```ts
describe("resolveGroup", () => {
  it("resolves a single-member group: cleans aliases/anchors, normalizes first anchor", () => {
    const e = mkEntity({
      id: "carl",
      canonicalName: "Carl",
      aliases: ["Carl", "the Crawler"],
      appearances: ["B1·C2·¶3", "B1·C1·¶1"],
      firstAppearance: { anchor: "[B1·C1·¶1]", snippet: "Carl woke." },
    });
    const r = resolveGroup([e]);
    expect(r.aliases).toEqual(["the Crawler"]); // canonical-equal alias dropped
    expect(r.appearances).toEqual(["B1·C1·¶1", "B1·C2·¶3"]); // sorted, normalized
    expect(r.firstAppearance?.anchor).toBe("B1·C1·¶1");
  });

  it("merges a multi-member group: most-appearances primary, unions aliases/tags, longest desc, max significance", () => {
    const primary = mkEntity({
      id: "bucket-boy",
      canonicalName: "Bucket Boy",
      aliases: ["BB"],
      tags: ["in_world"],
      significance: "minor",
      description: "short",
      appearances: ["B3·C1·¶1", "B3·C2·¶2"],
    });
    const dup = mkEntity({
      id: "bucket-boy-2",
      canonicalName: "The Bucket Boy",
      aliases: ["Crocodilian"],
      tags: ["item_object"],
      significance: "supporting",
      description: "a much longer description",
      appearances: ["B8·C5·¶9"],
    });
    const r = resolveGroup([primary, dup]);
    expect(r.id).toBe("bucket-boy"); // primary = most appearances
    expect(r.canonicalName).toBe("Bucket Boy");
    expect(r.aliases).toEqual(expect.arrayContaining(["BB", "Crocodilian", "The Bucket Boy"]));
    expect(r.tags.sort()).toEqual(["in_world", "item_object"]);
    expect(r.significance).toBe("supporting");
    expect(r.description).toBe("a much longer description");
    expect(r.appearances).toEqual(["B3·C1·¶1", "B3·C2·¶2", "B8·C5·¶9"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry.test.ts -t resolveGroup`
Expected: FAIL — `resolveGroup is not exported` / not a function.

- [ ] **Step 3: Refactor `dedupe` to expose `resolveGroup`**

In `src/registry.ts`, replace the body of `dedupe` from the start of the `for (const group of groups.values())` loop through the `out.push({...})` block (currently lines ~245-289) so that both the single- and multi-member branches call a new exported `resolveGroup`. The final function set reads:

```ts
/** Resolve a group of variant entities into one canonical entity (dedupe's merge logic). */
export function resolveGroup(group: RegistryEntity[]): RegistryEntity {
  const primary = [...group].sort(
    (a, b) => b.appearances.length - a.appearances.length || a.canonicalName.length - b.canonicalName.length,
  )[0] as RegistryEntity;

  const aliasSet = new Set<string>();
  const anchorSet = new Set<string>();
  const tagSet = new Set<EntityTag>();
  let description = primary.description;
  let significance = primary.significance;
  for (const e of group) {
    if (e !== primary) aliasSet.add(e.canonicalName);
    e.aliases.forEach((a) => aliasSet.add(a));
    e.appearances.forEach((a) => anchorSet.add(a));
    e.tags.forEach((t) => tagSet.add(t));
    if (e.description.length > description.length) description = e.description;
    if (SIG_RANK[e.significance] > SIG_RANK[significance]) significance = e.significance;
  }
  aliasSet.delete(primary.canonicalName);

  return {
    ...primary,
    aliases: cleanAliases(primary.canonicalName, [...aliasSet]),
    appearances: cleanAnchors([...anchorSet]),
    tags: [...tagSet],
    description,
    significance,
    firstAppearance: primary.firstAppearance
      ? { ...primary.firstAppearance, anchor: normalizeAnchor(primary.firstAppearance.anchor) }
      : null,
  };
}

/**
 * Collapse entities that are obvious variants of one another (same name modulo
 * case/punctuation, or a leading "Crawler"-style title). Unions aliases,
 * appearances, and tags; keeps the most-attested name as canonical and the
 * strongest significance / longest description. Also sorts every entity's
 * appearances into reading order. Returns the new registry and the merge count.
 */
export function dedupe(registry: Registry): { registry: Registry; merged: number } {
  const groups = new Map<string, RegistryEntity[]>();
  for (const e of registry.entities) {
    const key = mergeKey(e.canonicalName);
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }

  const out: RegistryEntity[] = [];
  let merged = 0;
  for (const group of groups.values()) {
    merged += group.length - 1;
    out.push(resolveGroup(group));
  }

  out.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  return { registry: { booksProcessed: registry.booksProcessed, entities: out }, merged };
}
```

(`merged += group.length - 1` is `0` for singletons, matching the old per-branch accounting.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/registry.test.ts test/dedupe.test.ts`
Expected: PASS (the new `resolveGroup` tests and the existing `dedupe` tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts test/registry.test.ts
git commit -m "registry: extract resolveGroup from dedupe for reuse by materialize"
```

---

## Task 3: `withinCutoff` gating helper

**Files:**
- Create: `src/log.ts`
- Test: `test/log.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/log.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { withinCutoff } from "../src/log.js";

describe("withinCutoff", () => {
  it("returns true for every anchor when no cutoff is given", () => {
    expect(withinCutoff("B8·C25·¶64")).toBe(true);
  });

  it("gates by book", () => {
    expect(withinCutoff("B2·C1·¶1", "B3·C1")).toBe(true);
    expect(withinCutoff("B4·C1·¶1", "B3·C1")).toBe(false);
  });

  it("a chapter cutoff includes the whole chapter (paragraph -> infinity)", () => {
    expect(withinCutoff("B2·C4·¶999", "B2·C4")).toBe(true);
    expect(withinCutoff("B2·C5·¶1", "B2·C4")).toBe(false);
  });

  it("a paragraph cutoff is inclusive at the paragraph", () => {
    expect(withinCutoff("B2·C4·¶7", "B2·C4·¶7")).toBe(true);
    expect(withinCutoff("B2·C4·¶8", "B2·C4·¶7")).toBe(false);
  });

  it("orders special sections via anchorSortKey (Prologue before C1, Epilogue after)", () => {
    expect(withinCutoff("B2·Prologue·¶1", "B2·C1")).toBe(true);
    expect(withinCutoff("B2·Epilogue·¶1", "B2·C99")).toBe(false);
  });

  it("normalizes bracketed anchors before comparing", () => {
    expect(withinCutoff("[B2·C1·¶1]", "B2·C1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/log.test.ts`
Expected: FAIL — cannot find module `../src/log.js`.

- [ ] **Step 3: Create `src/log.ts` with `withinCutoff`**

```ts
import { anchorSortKey, normalizeAnchor } from "./registry.js";
import type { Cutoff } from "./types.js";

/**
 * Is `anchor` at or before the reading-position `cutoff`?
 * A chapter cutoff ("B2·C4") includes the whole chapter; a paragraph cutoff
 * ("B2·C4·¶7") is inclusive at that paragraph. No cutoff ⇒ always true.
 */
export function withinCutoff(anchor: string, cutoff?: Cutoff): boolean {
  if (!cutoff) return true;
  const a = anchorSortKey(normalizeAnchor(anchor));
  const k = anchorSortKey(normalizeAnchor(cutoff));
  const cutoffPara = cutoff.includes("¶") ? k[2] : Number.POSITIVE_INFINITY;
  if (a[0] !== k[0]) return a[0] < k[0];
  if (a[1] !== k[1]) return a[1] < k[1];
  return a[2] <= cutoffPara;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/log.ts test/log.test.ts
git commit -m "log: add withinCutoff reading-position gate"
```

---

## Task 4: `materialize` — fold, gate, group, resolve

**Files:**
- Modify: `src/log.ts`
- Test: `test/log.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/log.test.ts` (extend the import to `import { materialize, withinCutoff } from "../src/log.js";` and add `import type { RegistryDelta } from "../src/types.js";`):

```ts
function fullEntity(p: Partial<import("../src/types.js").RegistryEntity> & { id: string; canonicalName: string; firstAppearance: { anchor: string; snippet: string } }) {
  return {
    aliases: [], type: "person" as const, tags: ["in_world" as const],
    significance: "minor" as const, description: "", appearances: [], ...p,
  };
}

const deltas: RegistryDelta[] = [
  {
    booksProcessed: [1],
    matched: [],
    newEntities: [
      fullEntity({
        id: "carl", canonicalName: "Carl", aliases: ["the Crawler"], description: "A crawler.",
        firstAppearance: { anchor: "B1·C1·¶1", snippet: "Carl woke." },
        appearances: ["B1·C1·¶1", "B1·C5·¶3"],
      }),
    ],
  },
  {
    booksProcessed: [1, 3],
    matched: [
      { id: "carl", anchor: "B3·C1·¶10", aliases: ["Crawler #4,122"] },
      { id: "bucket-boy-2", anchor: "B3·C2·¶4", aliases: [] }, // dangling id -> merges to bucket-boy
    ],
    newEntities: [
      fullEntity({
        id: "bucket-boy", canonicalName: "Bucket Boy", description: "short",
        firstAppearance: { anchor: "B3·C1·¶1", snippet: "A boy." }, appearances: ["B3·C1·¶1"],
      }),
      fullEntity({
        id: "bucket-boy-2", canonicalName: "The Bucket Boy", description: "a longer description",
        firstAppearance: { anchor: "B3·C2·¶4", snippet: "The boy." }, appearances: ["B3·C2·¶4"],
      }),
    ],
  },
];
const mergeMap = { "bucket-boy-2": "bucket-boy" };

describe("materialize", () => {
  it("folds all events into a registry when no cutoff is given", () => {
    const reg = materialize(deltas, mergeMap);
    expect(reg.booksProcessed).toEqual([1, 3]);
    const carl = reg.entities.find((e) => e.id === "carl")!;
    expect(carl.appearances).toEqual(["B1·C1·¶1", "B1·C5·¶3", "B3·C1·¶10"]);
    expect(carl.aliases).toEqual(expect.arrayContaining(["the Crawler", "Crawler #4,122"]));
  });

  it("merges dangling ids through the merge-map, keeping the longest description", () => {
    const reg = materialize(deltas, mergeMap);
    const ids = reg.entities.map((e) => e.id);
    expect(ids).toContain("bucket-boy");
    expect(ids).not.toContain("bucket-boy-2");
    const bb = reg.entities.find((e) => e.id === "bucket-boy")!;
    expect(bb.appearances).toEqual(["B3·C1·¶1", "B3·C2·¶4"]);
    expect(bb.description).toBe("a longer description");
    expect(bb.aliases).toContain("The Bucket Boy");
  });

  it("gates by reading position: entities introduced after the cutoff are absent, later anchors dropped", () => {
    const reg = materialize(deltas, mergeMap, { upTo: "B1·C99" });
    expect(reg.entities.map((e) => e.id)).toEqual(["carl"]);
    const carl = reg.entities[0]!;
    expect(carl.appearances).toEqual(["B1·C1·¶1", "B1·C5·¶3"]); // no B3 anchor
    expect(carl.aliases).not.toContain("Crawler #4,122"); // B3 alias gated out
  });

  it("sorts entities by canonical name", () => {
    const reg = materialize(deltas, mergeMap);
    expect(reg.entities.map((e) => e.canonicalName)).toEqual(["Bucket Boy", "Carl"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/log.test.ts -t materialize`
Expected: FAIL — `materialize is not a function`.

- [ ] **Step 3: Implement `materialize` in `src/log.ts`**

Add to `src/log.ts` (extend imports to include `anchorSortKey, normalizeAnchor, cleanAliases, resolveGroup` from `./registry.js` and the needed types):

```ts
import { anchorSortKey, cleanAliases, normalizeAnchor, resolveGroup } from "./registry.js";
import type { AliasSupplement, Cutoff, MergeMap, Registry, RegistryDelta, RegistryEntity } from "./types.js";

function bookOf(anchor: string): number {
  return anchorSortKey(anchor)[0];
}

function newBookOf(delta: RegistryDelta): number {
  return delta.booksProcessed.length ? Math.max(...delta.booksProcessed) : 0;
}

function firstAnchorOf(ne: RegistryEntity): string | null {
  if (ne.firstAppearance) return normalizeAnchor(ne.firstAppearance.anchor);
  const sorted = ne.appearances
    .map(normalizeAnchor)
    .sort((a, b) => {
      const ka = anchorSortKey(a);
      const kb = anchorSortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    });
  return sorted[0] ?? null;
}

/**
 * Replay the per-book deltas into a registry, gated to a reading position.
 *
 * Events are folded into raw entities keyed by their delta id, then grouped by
 * the frozen `mergeMap` (id → canonical id) and resolved with `resolveGroup` —
 * the same field logic `dedupe` uses — so a full materialization reproduces the
 * committed registry exactly and gated views stay consistent with it.
 */
export function materialize(
  deltas: RegistryDelta[],
  mergeMap: MergeMap = {},
  options: { upTo?: Cutoff; aliasSupplement?: AliasSupplement } = {},
): Registry {
  const { upTo, aliasSupplement = {} } = options;
  const raw = new Map<string, RegistryEntity>();

  for (const delta of [...deltas].sort((a, b) => newBookOf(a) - newBookOf(b))) {
    for (const ne of delta.newEntities) {
      const first = firstAnchorOf(ne);
      if (!first || !withinCutoff(first, upTo)) continue; // introduced after the cutoff
      const keptAnchors = [...new Set(ne.appearances.map(normalizeAnchor).filter((a) => withinCutoff(a, upTo)))];
      const existing = raw.get(ne.id);
      if (existing) {
        for (const a of keptAnchors) if (!existing.appearances.includes(a)) existing.appearances.push(a);
        existing.aliases.push(...ne.aliases);
      } else {
        raw.set(ne.id, { ...ne, appearances: keptAnchors, aliases: [...ne.aliases] });
      }
    }
    for (const m of delta.matched) {
      const anchor = normalizeAnchor(m.anchor);
      if (!withinCutoff(anchor, upTo)) continue;
      const entity = raw.get(m.id);
      if (!entity) continue; // intro gated out or unknown id — skip defensively
      if (!entity.appearances.includes(anchor)) entity.appearances.push(anchor);
      if (m.aliases.length > 0) entity.aliases.push(...m.aliases);
    }
  }

  // Group by canonical id (frozen map) and resolve with dedupe's logic.
  const groups = new Map<string, RegistryEntity[]>();
  for (const [rawId, entity] of raw) {
    const canonicalId = mergeMap[rawId] ?? rawId;
    const group = groups.get(canonicalId);
    if (group) group.push(entity);
    else groups.set(canonicalId, [entity]);
  }

  const entities: RegistryEntity[] = [];
  for (const [canonicalId, group] of groups) {
    const resolved = resolveGroup(group);
    resolved.id = canonicalId;
    const extra = aliasSupplement[canonicalId];
    if (extra && extra.length > 0) {
      resolved.aliases = cleanAliases(resolved.canonicalName, [...resolved.aliases, ...extra]);
    }
    entities.push(resolved);
  }

  entities.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  const booksProcessed = [...new Set(entities.flatMap((e) => e.appearances).map(bookOf))].sort((a, b) => a - b);
  return { booksProcessed, entities };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/log.test.ts`
Expected: PASS (all `withinCutoff` and `materialize` tests).

- [ ] **Step 5: Commit**

```bash
git add src/log.ts test/log.test.ts
git commit -m "log: add materialize (gated fold + frozen-map group resolution)"
```

---

## Task 5: `synthesizeEarlyDeltas` — build books 1–2 deltas from the registry

**Files:**
- Create: `src/synthesize.ts`
- Test: `test/synthesize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/synthesize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { synthesizeEarlyDeltas } from "../src/synthesize.js";
import type { Registry, RegistryEntity } from "../src/types.js";

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
      appearances: ["B1·C1·¶1", "B2·C3·¶5", "B3·C1·¶10"], // spans 1,2,3
    }),
    mkEntity({
      id: "donut", canonicalName: "Princess Donut", description: "A cat.",
      firstAppearance: { anchor: "B2·C1·¶2", snippet: "A cat." },
      appearances: ["B2·C1·¶2"], // introduced in book 2
    }),
    mkEntity({
      id: "mordecai", canonicalName: "Mordecai",
      firstAppearance: { anchor: "B3·C2·¶1", snippet: "Mordecai." },
      appearances: ["B3·C2·¶1"], // book 3 only — must NOT appear in synthesized 1/2
    }),
  ],
};

describe("synthesizeEarlyDeltas", () => {
  it("introduces book-1 entities in delta 1 with only their book-1 anchors", () => {
    const { 1: d1 } = synthesizeEarlyDeltas(registry, [1, 2]);
    expect(d1.booksProcessed).toEqual([1]);
    const carl = d1.newEntities.find((e) => e.id === "carl")!;
    expect(carl.appearances).toEqual(["B1·C1·¶1"]);
    expect(carl.firstAppearance?.anchor).toBe("B1·C1·¶1");
    expect(carl.description).toBe("A crawler.");
    expect(carl.aliases).toEqual(["the Crawler"]);
    expect(d1.newEntities.map((e) => e.id)).not.toContain("mordecai");
  });

  it("re-mentions a book-1 entity seen again in book 2 as a matched event, not a new entity", () => {
    const { 2: d2 } = synthesizeEarlyDeltas(registry, [1, 2]);
    expect(d2.booksProcessed).toEqual([1, 2]);
    expect(d2.matched).toContainEqual({ id: "carl", anchor: "B2·C3·¶5", aliases: [] });
    expect(d2.newEntities.map((e) => e.id)).not.toContain("carl");
  });

  it("introduces a book-2-first entity in delta 2", () => {
    const { 2: d2 } = synthesizeEarlyDeltas(registry, [1, 2]);
    const donut = d2.newEntities.find((e) => e.id === "donut")!;
    expect(donut.appearances).toEqual(["B2·C1·¶2"]);
    expect(donut.firstAppearance?.anchor).toBe("B2·C1·¶2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/synthesize.test.ts -t synthesizeEarlyDeltas`
Expected: FAIL — cannot find module `../src/synthesize.js`.

- [ ] **Step 3: Implement `synthesizeEarlyDeltas`**

Create `src/synthesize.ts`:

```ts
import { anchorSortKey, normalizeAnchor } from "./registry.js";
import type { Registry, RegistryDelta, RegistryEntity } from "./types.js";

function bookOf(anchor: string): number {
  return anchorSortKey(normalizeAnchor(anchor))[0];
}

function sortAnchors(anchors: string[]): string[] {
  return [...anchors].sort((a, b) => {
    const ka = anchorSortKey(a);
    const kb = anchorSortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

/**
 * Derive per-book deltas for the given early `books` (e.g. [1, 2]) from the
 * registry. An entity is *introduced* (a newEntity) in the book of its first
 * appearance; appearances in a later early book become *matched* events there.
 * Aliases/description/type/tags/significance are carried from the registry at
 * introduction (the accepted Phase-1 fidelity caveat).
 *
 * Returns a record keyed by book number.
 */
export function synthesizeEarlyDeltas(registry: Registry, books: number[]): Record<number, RegistryDelta> {
  const bookSet = new Set(books);
  const out: Record<number, RegistryDelta> = {};
  for (const b of books) {
    out[b] = {
      booksProcessed: books.filter((x) => x <= b),
      matched: [],
      newEntities: [],
    };
  }

  for (const e of registry.entities) {
    const earlyAnchors = e.appearances.map(normalizeAnchor).filter((a) => bookSet.has(bookOf(a)));
    if (earlyAnchors.length === 0) continue;

    const introBook = bookOf(normalizeAnchor(e.firstAppearance?.anchor ?? sortAnchors(earlyAnchors)[0]!));
    for (const b of books) {
      const bookAnchors = sortAnchors(earlyAnchors.filter((a) => bookOf(a) === b));
      if (bookAnchors.length === 0) continue;
      if (b === introBook) {
        const intro: RegistryEntity = {
          ...e,
          appearances: bookAnchors,
          firstAppearance: e.firstAppearance
            ? { ...e.firstAppearance, anchor: normalizeAnchor(e.firstAppearance.anchor) }
            : { anchor: bookAnchors[0]!, snippet: "" },
        };
        out[b]!.newEntities.push(intro);
      } else {
        for (const anchor of bookAnchors) out[b]!.matched.push({ id: e.id, anchor, aliases: [] });
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/synthesize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/synthesize.ts test/synthesize.test.ts
git commit -m "synthesize: derive books 1-2 deltas from the registry"
```

---

## Task 6: `buildMergeMap` and `buildAliasSupplement`

**Files:**
- Modify: `src/synthesize.ts`
- Test: `test/synthesize.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/synthesize.test.ts` (extend the import: `import { buildAliasSupplement, buildMergeMap, synthesizeEarlyDeltas } from "../src/synthesize.js";` and `import type { Registry, RegistryDelta, RegistryEntity } from "../src/types.js";`):

```ts
describe("buildMergeMap", () => {
  const reg: Registry = {
    booksProcessed: [3],
    entities: [mkEntity({ id: "bucket-boy", canonicalName: "Bucket Boy" })],
  };
  const rawDeltas: RegistryDelta[] = [
    {
      booksProcessed: [3], matched: [],
      newEntities: [
        mkEntity({ id: "bucket-boy", canonicalName: "Bucket Boy" }),
        mkEntity({ id: "bucket-boy-2", canonicalName: "Bucket Boy!" }), // dangling newEntity (punctuation variant)
      ],
    },
  ];

  it("maps each dangling newEntity id to its canonical (mergeKey match)", () => {
    expect(buildMergeMap(reg, rawDeltas)).toEqual({ "bucket-boy-2": "bucket-boy" });
  });

  it("drops a matched-only dangling id (never introduced) instead of throwing", () => {
    // Mirrors applyDelta dropping unknown matched ids (e.g. the real 'sam' in book 6).
    const matchedOnly: RegistryDelta[] = [
      { booksProcessed: [3], matched: [{ id: "sam", anchor: "B3·C1·¶1", aliases: [] }], newEntities: [] },
    ];
    expect(buildMergeMap(reg, matchedOnly)).toEqual({}); // "sam" left unmapped, no throw
  });

  it("throws if a dangling newEntity id cannot be resolved to a registry entity", () => {
    const orphan: RegistryDelta[] = [
      { booksProcessed: [3], matched: [], newEntities: [mkEntity({ id: "ghost-2", canonicalName: "Ghost Person" })] },
    ];
    expect(() => buildMergeMap(reg, orphan)).toThrow(/ghost-2/);
  });
});

describe("buildAliasSupplement", () => {
  it("captures registry aliases that folding the deltas would not produce", () => {
    const reg: Registry = {
      booksProcessed: [3],
      entities: [mkEntity({ id: "carl", canonicalName: "Carl", aliases: ["Crawler #4,122", "the Crawler"] })],
    };
    const rawDeltas: RegistryDelta[] = [
      {
        booksProcessed: [3],
        matched: [{ id: "carl", anchor: "B3·C1·¶1", aliases: ["the Crawler"] }],
        newEntities: [],
      },
    ];
    // "Crawler #4,122" is in the registry but never in a delta event -> supplement.
    expect(buildAliasSupplement(reg, rawDeltas, {})).toEqual({ carl: ["Crawler #4,122"] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/synthesize.test.ts -t buildMergeMap`
Expected: FAIL — `buildMergeMap is not a function`.

- [ ] **Step 3: Implement both helpers**

Add to `src/synthesize.ts` (extend the import from `./registry.js` to `import { anchorSortKey, mergeKey, normalizeAnchor, normalizeName } from "./registry.js";`):

```ts
import type { AliasSupplement, MergeMap } from "./types.js";

/**
 * Build the frozen merge-map: every entity id referenced in `rawDeltas` that is
 * absent from the registry (a dedupe collision) maps to the canonical registry
 * entity sharing its mergeKey. Throws if any dangling id cannot be resolved.
 */
export function buildMergeMap(registry: Registry, rawDeltas: RegistryDelta[]): MergeMap {
  const registryIds = new Set(registry.entities.map((e) => e.id));
  const canonicalByKey = new Map<string, string>();
  for (const e of registry.entities) {
    const key = mergeKey(e.canonicalName);
    if (!canonicalByKey.has(key)) canonicalByKey.set(key, e.id);
  }

  // Names for dangling ids come from their newEntity introductions.
  const nameById = new Map<string, string>();
  for (const d of rawDeltas) for (const ne of d.newEntities) nameById.set(ne.id, ne.canonicalName);

  const map: MergeMap = {};
  for (const d of rawDeltas) {
    const ids = [...d.newEntities.map((e) => e.id), ...d.matched.map((m) => m.id)];
    for (const id of ids) {
      if (registryIds.has(id) || map[id]) continue;
      const name = nameById.get(id);
      // A matched-only dangling id (never introduced as a newEntity, e.g. the real
      // 'sam' matched once in book 6) is dropped at fold time exactly as applyDelta
      // drops unknown matched ids — leave it unmapped rather than throwing.
      if (!name) continue;
      const canonical = canonicalByKey.get(mergeKey(name));
      if (!canonical) {
        throw new Error(`buildMergeMap: cannot resolve dangling newEntity id "${id}" (name: ${name}) to a registry entity`);
      }
      map[id] = canonical;
    }
  }
  return map;
}

/**
 * Capture aliases present in the registry but not produced by folding the deltas
 * (e.g. residue from the crawler-numbers pass). Keyed by canonical id.
 */
export function buildAliasSupplement(
  registry: Registry,
  rawDeltas: RegistryDelta[],
  mergeMap: MergeMap,
): AliasSupplement {
  const provided = new Map<string, Set<string>>(); // canonical id -> normalized aliases the deltas yield
  const add = (id: string, name: string): void => {
    const cid = mergeMap[id] ?? id;
    const set = provided.get(cid) ?? new Set<string>();
    set.add(normalizeName(name));
    provided.set(cid, set);
  };
  for (const d of rawDeltas) {
    for (const ne of d.newEntities) {
      add(ne.id, ne.canonicalName);
      for (const a of ne.aliases) add(ne.id, a);
    }
    for (const m of d.matched) for (const a of m.aliases) add(m.id, a);
  }

  const supplement: AliasSupplement = {};
  for (const e of registry.entities) {
    const have = provided.get(e.id);
    // Skip entities that never appear in the raw deltas (their data is synthesized from the registry verbatim).
    if (!have) continue;
    const missing = e.aliases.filter((a) => !have.has(normalizeName(a)) && normalizeName(a) !== normalizeName(e.canonicalName));
    if (missing.length > 0) supplement[e.id] = missing;
  }
  return supplement;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/synthesize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/synthesize.ts test/synthesize.test.ts
git commit -m "synthesize: build frozen merge-map and alias supplement"
```

---

## Task 7: Migration script + reproduction gate

This wires the helpers against the real `../dcc` data, writes the artifacts, and **fails if `materialize(full)` does not reproduce `registry.json`**.

**Files:**
- Create: `src/migrate-to-log.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Add the npm script**

In `package.json`, add to `"scripts"` (after `"apply-delta"`):

```json
    "migrate-to-log": "tsx src/migrate-to-log.ts",
```

- [ ] **Step 2: Implement the migration**

Create `src/migrate-to-log.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "./log.js";
import { buildAliasSupplement, buildMergeMap, synthesizeEarlyDeltas } from "./synthesize.js";
import type { Registry, RegistryDelta } from "./types.js";

/** Recursively sort object keys so deep equality ignores key order but respects array order. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = stable((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

function loadDeltas(deltasDir: string, books: number[]): RegistryDelta[] {
  return books.map((b) => JSON.parse(readFileSync(join(deltasDir, `delta-book${b}.json`), "utf8")) as RegistryDelta);
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const seriesDir = join(here, "..", "..", "dcc"); // casefiles/dcc
  const deltasDir = join(seriesDir, "deltas");
  const registryPath = join(seriesDir, "output", "registry.json");
  if (!existsSync(registryPath)) {
    console.error(`migrate-to-log: ${registryPath} not found`);
    process.exit(1);
  }
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;

  // 1. Synthesize books 1-2 deltas from the registry and write them.
  const early = synthesizeEarlyDeltas(registry, [1, 2]);
  for (const b of [1, 2]) {
    writeFileSync(join(deltasDir, `delta-book${b}.json`), JSON.stringify(early[b]), "utf8");
  }

  // 2. Build the frozen merge-map + alias supplement from the raw 3-8 deltas.
  const rawDeltas = loadDeltas(deltasDir, [3, 4, 5, 6, 7, 8]);
  const mergeMap = buildMergeMap(registry, rawDeltas);
  const aliasSupplement = buildAliasSupplement(registry, rawDeltas, mergeMap);
  writeFileSync(join(deltasDir, "merge-map.json"), JSON.stringify(mergeMap, null, 2), "utf8");
  writeFileSync(join(deltasDir, "alias-supplement.json"), JSON.stringify(aliasSupplement, null, 2), "utf8");

  // 3. Verify full materialization reproduces the committed registry (hard gate).
  const allDeltas = loadDeltas(deltasDir, [1, 2, 3, 4, 5, 6, 7, 8]);
  const full = materialize(allDeltas, mergeMap, { aliasSupplement });
  if (JSON.stringify(stable(full)) !== JSON.stringify(stable(registry))) {
    console.error(
      `migrate-to-log: FAILED reproduction — materialize(full) != registry.json ` +
        `(${full.entities.length} vs ${registry.entities.length} entities). Artifacts written for inspection.`,
    );
    process.exit(1);
  }

  // 4. Diagnostic: through-book-7 view (not a hard gate).
  const through7 = materialize(allDeltas, mergeMap, { upTo: "B7·C99999", aliasSupplement });
  const snapPath = join(seriesDir, "output", "registry.books1-7.json");
  let diag = "skipped (no registry.books1-7.json)";
  if (existsSync(snapPath)) {
    const snap = JSON.parse(readFileSync(snapPath, "utf8")) as Registry;
    diag = JSON.stringify(stable(through7)) === JSON.stringify(stable(snap))
      ? "MATCH"
      : `DIFF (${through7.entities.length} vs ${snap.entities.length} entities)`;
  }

  console.log(
    `migrate-to-log: OK — reproduced registry.json (${full.entities.length} entities). ` +
      `merge-map: ${Object.keys(mergeMap).length} entries, alias-supplement: ${Object.keys(aliasSupplement).length} entries. ` +
      `through-B7 diagnostic: ${diag}.`,
  );
}

main();
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the migration against real DCC data**

Run: `npm run migrate-to-log`
Expected: `migrate-to-log: OK — reproduced registry.json (3824 entities). merge-map: 81 entries, alias-supplement: 1 entries. through-B7 diagnostic: MATCH.` (81 = the 82 dangling ids minus the matched-only `sam`, which is dropped not mapped. The exact merge-map/supplement counts matter less than the `OK — reproduced` gate passing.)

If reproduction FAILS: do not work around it. Diff `stable(full)` vs `stable(registry)` for the first differing entity (add a temporary diff print, or load both written-out structures in a scratch test) and fix `resolveGroup`/`materialize`/`synthesizeEarlyDeltas` until it reproduces. A `DIFF` on the through-B7 diagnostic is acceptable and should be reported, not fixed (it reveals `dedupe` order-sensitivity); only the full reproduction is a hard gate.

- [ ] **Step 5: Commit (code + generated artifacts)**

The deltas/merge-map live in the `casefiles` repo, not `dossier`. Commit the dossier code here; the data artifacts are committed in `casefiles` in Task 9.

```bash
git add src/migrate-to-log.ts package.json
git commit -m "migrate-to-log: synthesize 1-2, freeze merge-map/alias-supplement, verify reproduction"
```

---

## Task 8: `view` CLI

**Files:**
- Create: `src/view.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Add the npm script**

In `package.json` `"scripts"`, add (after the `migrate-to-log` line):

```json
    "view": "tsx src/view.ts",
```

- [ ] **Step 2: Implement the CLI**

Create `src/view.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "./log.js";
import { renderMarkdown } from "./render.js";
import type { AliasSupplement, MergeMap, RegistryDelta } from "./types.js";

/** Parse `--flag value` pairs; returns a map of flag → value. */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      out[a.slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return out;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = parseArgs(process.argv.slice(2));
  const seriesDir = join(here, "..", "..", args.series ?? "dcc");
  const deltasDir = join(seriesDir, "deltas");

  const books = [1, 2, 3, 4, 5, 6, 7, 8].filter((b) => existsSync(join(deltasDir, `delta-book${b}.json`)));
  const deltas = books.map((b) => JSON.parse(readFileSync(join(deltasDir, `delta-book${b}.json`), "utf8")) as RegistryDelta);
  const mergeMap: MergeMap = existsSync(join(deltasDir, "merge-map.json"))
    ? JSON.parse(readFileSync(join(deltasDir, "merge-map.json"), "utf8"))
    : {};
  const aliasSupplement: AliasSupplement = existsSync(join(deltasDir, "alias-supplement.json"))
    ? JSON.parse(readFileSync(join(deltasDir, "alias-supplement.json"), "utf8"))
    : {};

  const registry = materialize(deltas, mergeMap, { upTo: args.through || undefined, aliasSupplement });
  const at = args.through ? `through ${args.through}` : "full series";

  if (args.out) {
    writeFileSync(join(seriesDir, args.out), renderMarkdown(registry), "utf8");
    console.log(`view (${at}): ${registry.entities.length} entities -> ${args.out}`);
  } else {
    process.stdout.write(renderMarkdown(registry));
  }
}

main();
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Smoke-test the CLI**

Run: `npm run view -- --through B2·C4 --out output/characters.through-B2C4.md`
Expected: a line like `view (through B2·C4): <N> entities -> output/characters.through-B2C4.md`, where `<N>` is well under the 3,824 full-series count (only entities introduced by B2·C4). Then clean up the scratch file:

Run: `rm ../dcc/output/characters.through-B2C4.md`

- [ ] **Step 5: Commit**

```bash
git add src/view.ts package.json
git commit -m "view: CLI to materialize + render the log at a reading position"
```

---

## Task 9: Guarded reproduction regression test + commit data artifacts

**Files:**
- Create: `test/migration-repro.test.ts`

- [ ] **Step 1: Write the guarded integration test**

Create `test/migration-repro.test.ts`. It runs only when the DCC data is present (so the public `dossier` repo stays independently testable):

```ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { materialize } from "../src/log.js";
import type { AliasSupplement, MergeMap, Registry, RegistryDelta } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const deltasDir = join(here, "..", "..", "dcc", "deltas");
const registryPath = join(here, "..", "..", "dcc", "output", "registry.json");
const hasData = existsSync(registryPath) && existsSync(join(deltasDir, "merge-map.json"));

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = stable((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

describe.skipIf(!hasData)("DCC migration reproduction", () => {
  it("materialize(full) reproduces the committed registry.json", () => {
    const deltas = [1, 2, 3, 4, 5, 6, 7, 8].map(
      (b) => JSON.parse(readFileSync(join(deltasDir, `delta-book${b}.json`), "utf8")) as RegistryDelta,
    );
    const mergeMap = JSON.parse(readFileSync(join(deltasDir, "merge-map.json"), "utf8")) as MergeMap;
    const aliasSupplement = JSON.parse(readFileSync(join(deltasDir, "alias-supplement.json"), "utf8")) as AliasSupplement;
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;

    const full = materialize(deltas, mergeMap, { aliasSupplement });
    expect(full.entities.length).toBe(registry.entities.length);
    expect(stable(full)).toEqual(stable(registry));
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/migration-repro.test.ts`
Expected: PASS (1 test; not skipped, since the migration in Task 7 produced the artifacts).

- [ ] **Step 3: Full verification gate (lint, typecheck, test, build)**

Run each and confirm all pass:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: `lint` clean; `typecheck` clean; `npm test` all suites green (including the new `log`, `synthesize`, `resolveGroup`, and reproduction tests); `build` clean.

- [ ] **Step 4: Commit the dossier test**

```bash
git add test/migration-repro.test.ts
git commit -m "test: guarded DCC reproduction regression for materialize"
```

- [ ] **Step 5: Commit the generated data artifacts in the casefiles repo**

The synthesized deltas and frozen maps live in `casefiles/dcc/deltas/`. From the `casefiles` repo root:

```bash
cd ..
git add dcc/deltas/delta-book1.json dcc/deltas/delta-book2.json dcc/deltas/merge-map.json dcc/deltas/alias-supplement.json
git status   # confirm only these four files are staged (registry.json unchanged)
git commit -m "dcc: add synthesized 1-2 deltas + frozen merge-map/alias-supplement (log model)"
cd dossier
```

(Do not commit a bumped submodule pointer or push anything without explicit approval.)

---

## Self-Review

**Spec coverage:**
- Position-gated event log as source of truth → Tasks 3–4 (`withinCutoff`, `materialize`). ✓
- `materialize(deltas, mergeMap, upTo?)` pure, chapter/paragraph granularity → Task 4 + Task 3. ✓
- Reuse 3–8 deltas, synthesize 1–2 without re-extraction → Task 5. ✓
- Frozen merge-map for the 82 dedupe collisions → Task 6 (`buildMergeMap`). ✓
- Exact `registry.json` reproduction, test-verified → Task 7 (migration hard gate) + Task 9 (regression test). ✓
- B7 diagnostic (not a blocker) → Task 7. ✓
- `view --through` CLI → Task 8. ✓
- Reused `anchorSortKey`/`normalizeAnchor`/`dedupe` logic; series-agnostic log → Tasks 2–4, data under `dcc/`. ✓
- Reconciliation residue from `crawler-numbers` (1 alias) → Task 6 (`buildAliasSupplement`), a planned extension of the spec's single reconciliation artifact (flagged in the header). ✓
- Phase-1 limitation (descriptions stay blob) → encoded by materialize carrying introduction-time fields; Phase 2 out of scope. ✓

**Placeholder scan:** No `TODO`/`TBD`; every code step shows complete code; every run step shows the exact command and expected output. ✓

**Type consistency:** `materialize(deltas, mergeMap, { upTo, aliasSupplement })` used consistently in Tasks 4, 7, 8, 9. `resolveGroup(group)` defined in Task 2, used in Task 4. `synthesizeEarlyDeltas(registry, books)` returns `Record<number, RegistryDelta>` (Task 5) and is consumed as `early[b]` in Task 7. `buildMergeMap(registry, rawDeltas)` / `buildAliasSupplement(registry, rawDeltas, mergeMap)` signatures match Tasks 6 and 7. `MergeMap`/`AliasSupplement`/`Cutoff` defined in Task 1, used throughout. ✓
