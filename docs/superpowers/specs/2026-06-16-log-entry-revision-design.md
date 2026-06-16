# Log-entry revision — design

**Date:** 2026-06-16
**Status:** Approved (Phase 1 scope)
**Component:** `dossier` (tooling); DCC data migration lives in `casefiles/dcc/`

## Background

`dossier` builds a spoiler-aware character compendium from a book series. Today the
source of truth is a flat `registry.json`: each entity has a single cumulative
`description` plus a flat `appearances: string[]` of `B·C·¶` anchors. Because the
description reflects the *final* (last-book) state and was written full-series-aware, a
separate `registry.books1-7.json` snapshot exists to avoid spoilers — a workaround, not a
gating mechanism.

The per-book **deltas** (`dcc/deltas/delta-book3.json … delta-book8.json`) are already an
append-only, position-stamped event log. Books 1–2 predate the delta format; their data
lives folded into `registry.json` only.

The **log-entry revision** turns the event log into the source of truth and adds a
`materialize(log, upTo?)` function that replays events up to a reading position, giving
true spoiler-gated views. The flat `registry.json` becomes a *derived* artifact.

## Goals

- Make a position-gated event log the canonical store; `registry.json` becomes derived.
- `materialize(deltas, mergeMap, upTo?)` → `Registry`, a pure function gating by reading
  position to chapter (or paragraph) granularity.
- Reuse the existing 3–8 deltas; bring books 1–2 into the log **without re-extraction** by
  synthesizing their deltas deterministically from `registry.json`.
- Exact, test-verified reproduction of the committed `registry.json`.

### Non-goals (Phase 1)

- **Versioned descriptions.** The eventual target is per-chapter versioned descriptions
  (`description-set @ B·C`), so a gated view shows spoiler-safe prose. That requires a
  re-describe agent pass and is **Phase 2** (sketched below). In Phase 1, descriptions
  remain the existing single full-series blob — appearances/aliases gate correctly, prose
  does not.
- Per-series generalization (vending series, pluggable field extractors). The log format
  stays series-agnostic, but no generalization work is built here.

## Key findings driving the design

From analysis of the committed data:

- The 3–8 deltas are clean and per-book-partitioned (no cross-book bleed, not truncated):
  `matched` events carry `{id, anchor, aliases}` only; `newEntities` carry a full entity
  including one `description`.
- **`matched` events carry no description.** A description is written once, at entity
  introduction, and never versioned. So no existing data (deltas *or* registry) contains
  position-bounded descriptions — confirming Phase 2 is genuinely new work spanning all books.
- **Books 1–2 are reconstructable from `registry.json`.** It holds every B1/B2 anchor plus
  each entity's `firstAppearance`. 801 entities first-appear in B1/B2. Synthesized 1–2
  events are fidelity-equivalent to the 3–8 deltas (anchors + first-appearance snippet; no
  per-appearance snippets exist in any delta).
- **82 entities introduced in deltas 3–8 were later merged away by `dedupe`** (the `-2`
  suffix collisions, e.g. `bucket-boy-2` → `bucket-boy`). A raw replay would create 82
  phantom entities. The migration must freeze a merge-map.
- The codebase already provides the hard parts: `anchorSortKey()` (total order over
  `B·label·¶`, handling `C#`, `Prologue`, `Interlude`, `Epilogue`, `Sec#`, `Part#`),
  `normalizeAnchor()` (strips bracketed `[B4·C14·¶1]` anchors seen in delta-book4), and a
  working `dedupe()` keyed on `mergeKey(canonicalName)`.

## Architecture (Approach 2: normalized log + frozen merge-map)

Considered three approaches; chose the one that keeps position-gated views consistent with
the full view and allows exact `registry.json` reproduction:

- **Rejected — raw deltas, `dedupe` inside every `materialize`:** `dedupe` is a
  set-dependent fuzzy heuristic, so a position view could merge differently than the full
  view; slow; fragile reproduction.
- **Chosen — normalized log + frozen merge-map:** run `dedupe` once during migration to
  freeze an `id → canonicalId` map; `materialize` remaps ids at fold time with no fuzzy
  logic at query time. Deterministic, fast, consistent across cutoffs, exactly reproducible.
  Fuzzy `dedupe` only runs when ingesting genuinely new books, then re-freezes.
- **Rejected — keep `registry.json` canonical, add a derived index:** doesn't deliver
  "log is the source of truth" and can't version descriptions cleanly in Phase 2.

### Module map (`dossier/src/`)

| New file | Purpose |
|---|---|
| `log.ts` | `LogEvent`/cutoff types + `materialize(deltas, mergeMap, upTo?)` pure fold/gate function |
| `migrate-to-log.ts` | One-time deterministic migration: synthesize 1–2, build + verify merge-map and alias-supplement |
| `view.ts` | CLI: `view --through B2·C4` → `materialize` + `render` |

Reused as-is: `anchorSortKey`, `normalizeAnchor`, `dedupe`, `cleanAnchors` (registry.ts);
`render`/`groupAnchors` (render.ts). The existing `RegistryDelta` shape is the log batch.

### On-disk log format (under `casefiles/dcc/`)

- `dcc/deltas/delta-book1.json … delta-book8.json` — the log. 1–2 newly synthesized; 3–8
  left **untouched** (faithful record of what extraction emitted).
- `dcc/deltas/merge-map.json` — `{ "bucket-boy-2": "bucket-boy", … }`, the frozen dedupe
  collisions (the 82, plus any future ones). Applied as a lens at fold time; history is
  never rewritten.
- `dcc/deltas/alias-supplement.json` — `{ "<id>": ["Crawler #4,122", …] }`, aliases present
  in `registry.json` but not produced by folding the deltas. In DCC this is the residue of
  the **series-specific** `crawler-numbers` pass (in-world Crawler IDs the extraction agents
  didn't already capture inline) — measured at exactly **1 entry** for the current data.
  Like the merge-map, it's a frozen lens applied at fold time; required for exact
  reproduction without re-reading EPUB text. Applied globally (not position-gated) — a
  name-form leak is acceptable in Phase 1.

> **Generic vs. series-specific data — follow-up.** `merge-map.json` is generic
> (dedupe collisions occur in any series); `alias-supplement.json` is currently holding
> *series-specific* residue (crawler IDs). After implementation we need to decide how the
> on-disk layout separates generic reconciliation data from per-series data (e.g. a
> `<series>/` profile directory vs. shared files), so the vending series and future series
> don't inherit DCC-specific assumptions. Out of scope for Phase 1; tracked here so the
> decision isn't lost.

## `materialize(deltas, mergeMap, upTo?)` → `Registry`

Pure function; mirrors `applyDelta` but builds fresh, gated, and id-remapped.

- **Gate:** include an event iff `anchorSortKey(anchor) ≤ anchorSortKey(upTo)`. A chapter
  cutoff `B2·C4` means "through the end of C4" (paragraph → ∞); a paragraph cutoff
  `B2·C4·¶7` means through ¶7. No `upTo` ⇒ full series.
- **Fold (book order, deltas read fresh each call):**
  - `newEntity` whose `firstAppearance.anchor` passes the gate → introduce entity (id
    remapped through `mergeMap`). Because `firstAppearance` is the earliest anchor, a
    gated-out introduction safely drops the entity entirely.
  - `matched` event that passes the gate → remap id, append anchor to `appearances`, union
    `aliases` onto the (already-present) entity.
- **Post-fold:** `cleanAnchors` each entity's `appearances` into reading order;
  `booksProcessed` = books with any included event.
- **Phase-1 field semantics:** `type`/`tags`/`significance`/`description` come from the
  introduction event and are **not** versioned. Gated views show correct appearances and
  aliases but the full-series description blob (the known Phase-1 spoiler limitation).

## Migration (`migrate-to-log.ts`, one-time, deterministic)

1. **Synthesize `delta-book1.json` / `delta-book2.json`** from `registry.json`:
   - For each entity, collect its B1/B2 anchors. The entity is "introduced" in the book of
     its `firstAppearance` (only entities first-appearing in B1/B2, n=801, become
     `newEntities`; B1-introduced entities seen again in B2 contribute `matched` events to
     book 2).
   - `newEntities` carry the registry metadata (type/tags/significance/description) and the
     first-appearance snippet; aliases attached at introduction (best-effort — the accepted
     fidelity caveat, superseded by Phase 2 if desired).
2. **Build merge-map:** collect every id referenced across raw deltas 3–8; those absent
   from `registry.json` (the 82) are dedupe collisions. Map each to its canonical entity via
   the existing `mergeKey(canonicalName)` grouping — the same logic that produced the
   registry. Fail loudly if any dangling id does not resolve.
3. **Build alias-supplement:** for entities that appear in the raw deltas, collect any
   `registry.json` alias not produced by folding those deltas (the `crawler-numbers` residue
   — 1 entry for DCC). Entities whose data is synthesized verbatim from the registry (books
   1–2) have no gap by construction and are skipped.
4. **Verify (hard gate):** assert `materialize(allDeltas, mergeMap, { aliasSupplement })`
   deep-equals the committed `registry.json` (modulo key ordering). This is the migration's
   pass/fail and the safety net for trusting a 3,824-entity transform.
5. **Diagnostic check (not a blocker):** compare `materialize(…, through-B7)` to the
   committed `registry.books1-7.json`. Expected to match because descriptions are set once
   at introduction and book-8 merges/entities gate out at B7; a divergence would reveal
   `dedupe` order-sensitivity and is worth surfacing. `registry.json` reproduction is the
   hard requirement; the B7 match is a strong diagnostic.

## Outputs & CLI

- `npm run view -- --through B2·C4` → `materialize` + `render` to stdout or a file.
- `registry.json` remains committed as a *derived* artifact (convenient for diffing).
- New-book ingestion path going forward: extract → append delta → refresh merge-map via
  `dedupe` → `materialize`.

## Testing

- **`materialize` units:** synthetic log — gating at several cutoffs (chapter and
  paragraph), id remapping via merge-map, alias union, appearance sort order,
  `booksProcessed` computation.
- **Migration reproduction:** `materialize(full) === registry.json` (3,824 entities);
  the B7 diagnostic.
- **Synthesis:** synthesized 1–2 deltas, materialized alone, reproduce the B1/B2 slice of
  the registry.
- **`anchorSortKey` gating edges:** Prologue / Interlude / Epilogue / Sec# / `Part#` /
  bracketed anchors.

All Phase-1 work is deterministic; the existing `npm test` (vitest) suite is extended. No
agent runs, no EPUBs required.

## Phase 2 (documented, out of scope here)

Add `DescriptionEvent { id, anchor, text }` to the log. A re-describe agent pass reads the
series in order (text regenerable from EPUBs via `preprocess`) and emits **sparse**
versioned descriptions — a new version only when a chapter materially changes what's known,
never one per anchor. `materialize` selects the latest description event ≤ cutoff using the
same gating. This closes the prose spoiler hole end-to-end and is the proving ground for the
vending series. Re-describe spans all books (no existing data has versioned descriptions);
cost is a describe-only pass, far below the original ~$1,760 extraction run, provided
versioning stays sparse.
