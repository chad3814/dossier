# dossier

Build a **spoiler-aware character compendium** from a book series' EPUBs. For every named
entity in the series — people, creatures, factions, places, AI/system voices, even
mentioned-only and real-world references — `dossier` records:

- a canonical name + clustered aliases (including in-world IDs where present),
- **every appearance**, anchored to `B<book>·<section>·¶<paragraph>` in the source EPUBs,
- a description, and
- classification tags (`in_world` / `real_world_ref` / `media_ref` / `item_object`) so you can
  filter the noise.

It's like an X-Ray / who's-who index for a series, built to scale across many books and
(eventually) be queryable up to a given reading position so it stays spoiler-free.

## How it works

The pipeline is incremental and book-by-book. Each book seeds from the registry built by the
prior books, so recurring characters are **matched and extended** rather than re-created.

```
preprocess   EPUB → spine/TOC-ordered sections → plain text annotated with B·C·¶ markers
   │
gen-workflow generate the per-book extraction workflow, seeded with the known-character index
   │
workflow     (multi-agent) read each chapter in order, match against the known index or add
   │         new entities; describe newly-introduced entities — returns a per-book *delta*
apply-delta  fold the delta into registry.json (tested, deterministic)
dedupe       collapse case/punctuation/title-prefix variants; normalize + sort anchors
crawler-numbers   deterministic pass to attach in-world IDs by regex + lookup (series-specific)
render       registry.json → a readable Markdown compendium
```

The registry is the source of truth (`output/registry.json`); the per-book deltas are an
append-only event log. Pure data-handling steps (`apply-delta`, `dedupe`, `render`, `lookup`,
`crawler-numbers`) are deterministic and unit-tested; only extraction/description use agents.

## Usage

```bash
npm install
npm test                         # unit tests for the deterministic core
npm run preprocess -- book1.epub # → data/book1/sections + manifest.json
npm run gen-workflow -- 1        # seed the workflow from the current registry
# run the extraction workflow (see workflow/book-extract.js), save its delta, then:
npm run apply-delta -- data/_wf/delta-book1.json
npm run dedupe
npm run render                   # → output/characters.md
npm run lookup -- "the cat"      # fuzzy-find an entity in the registry
```

`data/`, `output/`, and `*.epub` are gitignored — they're local working artifacts and
series-specific generated data. EPUBs are never committed (copyright); the annotated section
text is fully regenerable from them via `preprocess`.

## Notes

- **Anchors are edition-specific.** They index the exact EPUB files you preprocess; a different
  edition renumbers paragraphs. EPUB has no fixed page numbers, so `¶` indices are the finest
  reliable, repeatable anchor.
- **Per-series bits.** `crawler-numbers.ts` (in-world ID extraction) and the extraction prompt's
  examples are tuned per series; generalizing these into a per-series profile is the intended
  next step.
- The extraction workflow is written for a multi-agent runner; `workflow/book-extract.js` is the
  logic template that `gen-workflow` parameterizes per book.
