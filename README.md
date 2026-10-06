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

The registry is the source of truth (`<series>/output/registry.json`); the per-book deltas are an
append-only event log. Pure data-handling steps (`apply-delta`, `dedupe`, `render`, `lookup`,
`crawler-numbers`) are deterministic and unit-tested; only extraction/description use agents.

## Usage

Every command operates on one series, named with `--series <id>` (or `DOSSIER_SERIES=<id>` in
the environment). A series is a sibling directory `../<id>/` of this checkout — see
[casefiles](https://github.com/chad3814/casefiles) — holding `series.json` (title, author, book
titles, per-series prompt rules), `epubs/`, `output/`, `log/`, and gitignored `data/` working
files.

```bash
npm install
npm test                                    # unit tests for the deterministic core
npm run preprocess     -- --series dcc 1    # ../dcc/epubs/book1.epub → ../dcc/data/book1/{sections,manifest.json}
npm run gen-workflow   -- --series dcc 1    # → ../dcc/data/_wf/book-extract.js, seeded from the registry
# run the extraction workflow (Workflow tool, scriptPath = that file), then:
npm run save-delta     -- --series dcc <workflow-output.json>   # flatten + validate → ../dcc/data/_wf/delta-book1.json
npm run apply-delta    -- --series dcc ../dcc/data/_wf/delta-book1.json
npm run gen-structure  -- --series dcc      # spine order for the new book — before dedupe
npm run dedupe         -- --series dcc
npm run render         -- --series dcc      # → ../dcc/output/characters.md
npm run lookup         -- --series dcc "the cat"
```

`*.epub` is never committed (copyright); the annotated section text is fully regenerable from
the EPUBs via `preprocess`.

## Notes

- **Anchors are edition-specific.** They index the exact EPUB files you preprocess; a different
  edition renumbers paragraphs. EPUB has no fixed page numbers, so `¶` indices are the finest
  reliable, repeatable anchor.
- **Per-series bits** live in `<series>/series.json`: book titles, prompt rules spliced into
  the extraction and re-describe workflows (`extraction.notes` / `redescribeNotes`), section
  exclusions and label overrides for `preprocess`, and opt-in steps such as `crawlerNumbers`.
- The extraction workflow is written for a multi-agent runner; `workflow/book-extract.js` is the
  logic template that `gen-workflow` parameterizes per book.
