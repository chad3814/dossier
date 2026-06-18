# Phase 2 — versioned descriptions — design

**Date:** 2026-06-17
**Status:** Approved (design); implementation + Book-1 pilot to follow
**Component:** `dossier` (tooling); DCC data lives in `casefiles/dcc/`
**Builds on:** `2026-06-16-log-entry-revision-design.md` (Phase 1)

## Background

Phase 1 made a position-gated event log the queryable form of the compendium:
`materialize(synthesizeLog(registry), {upTo})` reconstructs the registry as of a reading
position. **Appearances and aliases gate precisely.** Descriptions do not — every entity
carries a single full-series-aware blob (carried at introduction), so a gated view still
shows spoilery prose. Phase 1's spec called this out as the deferred work.

Phase 2 closes that gap: descriptions become **position-anchored, sparsely-versioned
events**. A view at `B5·C3` shows the latest description an attentive reader would know at
that point — written using only information through `B5·C3`.

## Decisions (from brainstorming)

- **Proving ground: DCC.** EPUBs are present; the Phase-1 log + registry give a structural
  ground truth to anchor against. Code stays series-agnostic so it transfers to the vending
  series later. (DCC is finished reading, so this is mechanism-proving.)
- **Cadence: sparse per-chapter, material-change.** A new version is emitted only when a
  chapter materially changes what's known about an entity; the agent judges. Versions are
  anchored at chapter precision (`B·C·¶`), so gating is chapter-precise.
- **Regenerate all descriptions as versioned events.** The registry blob is retired as the
  description source once a full run completes; every description is an agent-generated
  bounded version. This intentionally gives up Phase-1's exact reproduction of the
  `description` (and `significance`) fields — appearances/aliases/ids/tags/firstAppearance
  still reproduce exactly.
- **Workflow: chapter-sequential** (Approach 1) — most token-efficient, simplest
  material-change logic, bounded per-chapter context (avoids the growing-index cache-write
  cost that dominated the Phase-1 extraction bill).

## Goals

- A `DescriptionEvent` log stream + `materialize` overlay that selects the latest version
  ≤ a reading position, per entity.
- A chapter-sequential re-describe agent pass that emits sparse versioned descriptions from
  reading-order text, using only information through each chapter.
- Validate end-to-end on a **Book-1 pilot** (inspect timelines, measure tokens) before any
  full 8-book run.

### Non-goals (Phase 2)

- Per-series generalization (vending profile, pluggable field extractors).
- Character "sheets" / structured crunchy-LitRPG fields.
- Automated proof of spoiler-safety (inherently a judgment call on agent prose; we do
  structural checks + spot-checks, not a formal guarantee).

## Data model

```ts
/** One bounded description of an entity, valid from `anchor` until the next version. */
interface DescriptionEvent {
  id: string;                 // canonical entity id (matches registry / log ids)
  anchor: string;             // B·C·¶ where this version becomes known (anchorSortKey-sortable)
  description: string;        // written using only info through `anchor`
  significance: Significance; // versioned too — an entity can grow from minor → major
}
```

Persisted at `casefiles/dcc/log/descriptions.json` — a single array, sorted by
`anchorSortKey` then `id`. Separate stream from the appearance deltas (`dcc/log/delta-book*.json`),
so the two concerns stay independent and the appearance log is untouched.

## `materialize` overlay

`materialize` gains an optional third-option field `descriptions?: DescriptionEvent[]`.
After it has built and grouped entities from the appearance log (unchanged), it overlays
descriptions:

- For each entity, pick the `DescriptionEvent` with the greatest `anchorSortKey(anchor)`
  among those with `anchor ≤ cutoff` **and** matching the entity id; set the entity's
  `description` and `significance` from it.
- **Fallback:** if no event qualifies (entity not yet re-described, or none ≤ cutoff), keep
  the value already on the entity (the appearance-log blob). This makes partial runs (the
  pilot — only Book 1 has events) degrade gracefully: a `--through B1·…` view is fully
  versioned; a full view shows versions where they exist and blobs elsewhere.
- At full series (no cutoff) after a complete run, the latest version per entity replaces
  the blob entirely.

`materialize`'s appearance-side behavior is unchanged; this is a pure post-step.

## Re-describe workflow (chapter-sequential)

Mirrors the existing extraction pattern (`workflow/book-extract.js` template +
`src/gen-workflow.ts` injector):

- **`workflow/redescribe-book.js`** — the logic template. Per book, walking sections in
  reading order:
  - The chapter's appearing entities come from a per-book **chapter→entities** map built
    deterministically from the Phase-1 log (injected as a constant).
  - One agent per chapter, given: the chapter text (read via the Read tool from the
    preprocessed section file) and the appearing entities, each with its **current latest
    description** (or "not yet described"). The agent returns `{id, description,
    significance}` only for entities that are newly appearing or **materially developed**
    in this chapter, each written using only information through this chapter.
  - Each returned item becomes a `DescriptionEvent` anchored at that entity's first anchor
    in this chapter (a real `B·C·¶` from the log). Per-entity "current description" state is
    updated and threads forward.
  - Returns the book's `DescriptionEvent[]`.
- **`src/gen-redescribe.ts`** — the injector. Reads the book manifest (sections), the
  Phase-1 log (to build the chapter→entities map and the entity id/name index), and the
  **prior books' `descriptions.json`** (to seed each entity's current-description state, so
  the pass is sequential across books). Injects the constants block into a working copy of
  the template, same marker-replacement mechanism as `gen-workflow.ts`.
- The pass is **run** (not unit-tested); its deterministic inputs (the chapter→entities map,
  state seeding, event assembly, persistence) are unit-tested.

Bounded context: each chapter agent sees only that chapter's entities (typically a handful
to a few dozen), never the full registry — so prompts stay small and cacheable, unlike the
Phase-1 extraction's growing index.

## Text input

The agent needs prose, so we run the existing `preprocess` on the DCC EPUBs first
(regenerates `data/book*/sections/*.txt` + `manifest.json`; gitignored, regenerable). No new
extraction — appearances come from the Phase-1 log. `preprocess` only supplies text to read.

## Pilot, then full run

1. **Book-1 pilot:** `preprocess book1` → `gen-redescribe 1` → run the workflow → write
   Book-1 `DescriptionEvent`s. Inspect ~5 timelines (Carl, Donut, Mordecai, two minors) for
   spoiler-safety and quality; record token usage in `dcc/output/token-usage.md`.
2. **Decision gate (human):** review the pilot's quality and measured cost, then green-light
   Books 2–8. The full run seeds each book's state from prior books' events.

## Validation & testing

- **Deterministic unit tests:**
  - `materialize` overlay: latest-≤-cutoff selection; blob fallback when no event;
    `significance` versioning; an entity with versions at B1/B3/B6 resolves correctly at
    cutoffs B2, B4, B7.
  - `chapterEntities(log)` builder: correct chapter→entity-ids map and first-anchor-in-chapter.
  - `gen-redescribe` constant assembly: state seeding picks each entity's latest prior event.
  - Structural validators (a `validate-descriptions` check): per entity, events are in
    non-decreasing `anchor` order; the first version's anchor is ≥ the entity's earliest
    appearance; after a full run, every entity has ≥1 version. Reports violations; no silent
    truncation.
- **Agent-output checks (pilot, softer):** spot-check version timelines; optionally an
  adversarial verifier agent on a sample asserting a version references nothing past its
  anchor.

## Impact on Phase-1 artifacts

- The Phase-1 reproduction test (`test/migration-repro.test.ts`) is **narrowed** to compare
  every field except `description` and `significance` (which Phase 2 regenerates). A short
  comment records why. Appearances, aliases, ids, tags, and firstAppearance still reproduce
  exactly.
- `view` automatically renders bounded descriptions once `descriptions.json` exists (via the
  `materialize` overlay); no `view` API change beyond loading the descriptions file.
- `dcc/log/descriptions.json` is committed in `casefiles` (short bounded prose; same fair-use
  posture as the rest of the compendium).

## Module map (`dossier/src/`)

| File | Change | Responsibility |
|---|---|---|
| `types.ts` | add `DescriptionEvent` | the versioned-description event |
| `log.ts` | extend `materialize` | overlay latest-≤-cutoff descriptions; add `chapterEntities` |
| `gen-redescribe.ts` | new | inject per-book constants into the re-describe workflow template |
| `validate-descriptions.ts` | new | structural validators + CLI |
| `view.ts` | small | load `descriptions.json` and pass to `materialize` |
| `workflow/redescribe-book.js` | new | chapter-sequential re-describe logic template |
| `test/log.test.ts`, `test/redescribe.test.ts` | tests | overlay, chapterEntities, gen-redescribe, validators |
| `test/migration-repro.test.ts` | narrow | exclude description/significance |
