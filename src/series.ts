import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Per-series profile: casefiles/<id>/series.json. All fields required; [] / {} mean "none". */
export interface SeriesProfile {
  /** Must equal the directory name under casefiles/. */
  id: string;
  title: string;
  author: string;
  books: Array<{ number: number; title: string }>;
  extraction: {
    /** Series-specific prose rules spliced into the extraction prompt, one bullet each. */
    notes: string[];
    /** Series-specific prose rules spliced into the re-describe prompt. */
    redescribeNotes: string[];
  };
  preprocess: {
    /** Spine entries to drop: exact, case-insensitive match on TOC title or spine idref. */
    excludeSections: string[];
    /** Label overrides keyed by spine idref; still passed through uniqueLabel(). */
    sectionLabels: Record<string, string>;
  };
  steps: {
    /** Enable the deterministic crawler-number pass (DCC only). */
    crawlerNumbers: boolean;
  };
}

/** Every location a pipeline step may read or write for one series. */
export interface SeriesPaths {
  id: string;
  root: string;
  profile: string;
  outputDir: string;
  registry: string;
  logDir: string;
  corrections: string;
  epubsDir: string;
  dataDir: string;
  wfDir: string;
  epub(book: number): string;
  bookDir(book: number): string;
  sectionsDir(book: number): string;
  manifest(book: number): string;
}

export interface ResolvedSeries {
  paths: SeriesPaths;
  profile: SeriesProfile;
  /** argv with `--series <id>` removed — the caller's positional args and other flags. */
  rest: string[];
}

/** What the workflow templates need to know about a series. */
export interface SeriesPromptMeta {
  id: string;
  title: string;
  author: string;
  notes: string[];
}

export const SERIES_ENV = "DOSSIER_SERIES";

export class SeriesError extends Error {}

/** casefiles/ is the parent of the dossier checkout (casefiles/dossier/src/series.ts → casefiles). */
export function defaultCasefilesRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Pull `--series <id>` / `--series=<id>` out of argv, wherever it appears. */
export function parseSeriesArg(argv: string[]): { id: string | null; rest: string[] } {
  const rest: string[] = [];
  let id: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--series") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new SeriesError("--series requires a value");
      id = v;
      i++;
    } else if (a.startsWith("--series=")) {
      const v = a.slice("--series=".length);
      if (!v) throw new SeriesError("--series requires a value");
      id = v;
    } else {
      rest.push(a);
    }
  }
  return { id, rest };
}

export function seriesPaths(casefilesRoot: string, id: string): SeriesPaths {
  const root = join(casefilesRoot, id);
  const dataDir = join(root, "data");
  const bookDir = (book: number): string => join(dataDir, `book${book}`);
  return {
    id,
    root,
    profile: join(root, "series.json"),
    outputDir: join(root, "output"),
    registry: join(root, "output", "registry.json"),
    logDir: join(root, "log"),
    corrections: join(root, "corrections.json"),
    epubsDir: join(root, "epubs"),
    dataDir,
    wfDir: join(dataDir, "_wf"),
    epub: (book) => join(root, "epubs", `book${book}.epub`),
    bookDir,
    sectionsDir: (book) => join(bookDir(book), "sections"),
    manifest: (book) => join(bookDir(book), "manifest.json"),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function bad(field: string, want: string): SeriesError {
  return new SeriesError(`series.json: "${field}" must be ${want}`);
}

/** Narrow a parsed series.json to SeriesProfile or throw a SeriesError naming the bad field. */
export function validateProfile(raw: unknown, expectedId: string): SeriesProfile {
  if (!isRecord(raw)) throw new SeriesError("series.json: expected a JSON object");
  const { id, title, author, books, extraction, preprocess, steps } = raw;

  if (typeof id !== "string") throw bad("id", "a string");
  if (id !== expectedId) throw new SeriesError(`series.json: id "${id}" does not match directory "${expectedId}"`);
  if (typeof title !== "string" || title.length === 0) throw bad("title", "a non-empty string");
  if (typeof author !== "string" || author.length === 0) throw bad("author", "a non-empty string");

  if (!Array.isArray(books)) throw bad("books", "an array of { number, title }");
  const typedBooks: Array<{ number: number; title: string }> = [];
  for (const b of books) {
    if (!isRecord(b) || typeof b.number !== "number" || typeof b.title !== "string") {
      throw bad("books", "an array of { number: number, title: string }");
    }
    typedBooks.push({ number: b.number, title: b.title });
  }

  if (!isRecord(extraction) || !isStringArray(extraction.notes) || !isStringArray(extraction.redescribeNotes)) {
    throw bad("extraction", "{ notes: string[], redescribeNotes: string[] }");
  }

  if (!isRecord(preprocess) || !isStringArray(preprocess.excludeSections) || !isRecord(preprocess.sectionLabels)) {
    throw bad("preprocess", "{ excludeSections: string[], sectionLabels: Record<string, string> }");
  }
  const sectionLabels: Record<string, string> = {};
  for (const [k, v] of Object.entries(preprocess.sectionLabels)) {
    if (typeof v !== "string") throw bad("preprocess", "{ excludeSections: string[], sectionLabels: Record<string, string> }");
    // Labels become anchor tokens (B1·<label>·¶n) and file names; anything outside this set
    // would be mangled by normalizeAnchor / the section file namer and never match again.
    if (!/^[A-Za-z0-9_-]+$/.test(v)) throw bad(`preprocess.sectionLabels.${k}`, "an anchor-safe label matching [A-Za-z0-9_-]+");
    sectionLabels[k] = v;
  }

  if (!isRecord(steps) || typeof steps.crawlerNumbers !== "boolean") throw bad("steps", "{ crawlerNumbers: boolean }");

  return {
    id,
    title,
    author,
    books: typedBooks,
    extraction: { notes: extraction.notes, redescribeNotes: extraction.redescribeNotes },
    preprocess: { excludeSections: preprocess.excludeSections, sectionLabels },
    steps: { crawlerNumbers: steps.crawlerNumbers },
  };
}

export function loadSeries(casefilesRoot: string, id: string): { paths: SeriesPaths; profile: SeriesProfile } {
  const paths = seriesPaths(casefilesRoot, id);
  if (!existsSync(paths.root)) throw new SeriesError(`series "${id}": ${paths.root} does not exist`);
  if (!existsSync(paths.profile)) throw new SeriesError(`series "${id}": series.json not found at ${paths.profile}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.profile, "utf8"));
  } catch (e) {
    throw new SeriesError(`series "${id}": could not parse ${paths.profile}: ${(e as Error).message}`);
  }
  return { paths, profile: validateProfile(raw, id) };
}

export interface ResolveOptions {
  casefilesRoot?: string;
  env?: NodeJS.ProcessEnv;
}

/** Resolve the series from argv / env. Throws SeriesError; CLIs use resolveSeriesOrExit. */
export function resolveSeries(argv: string[], opts: ResolveOptions = {}): ResolvedSeries {
  const env = opts.env ?? process.env;
  const casefilesRoot = opts.casefilesRoot ?? defaultCasefilesRoot();
  const { id: flagId, rest } = parseSeriesArg(argv);
  const id = flagId ?? env[SERIES_ENV] ?? null;
  if (!id) throw new SeriesError(`no series given: pass --series <id> or set ${SERIES_ENV}`);
  const { paths, profile } = loadSeries(casefilesRoot, id);
  return { paths, profile, rest };
}

/** CLI entry: resolve the series or print the error plus usage and exit 1. */
export function resolveSeriesOrExit(argv: string[], usage: string): ResolvedSeries {
  try {
    return resolveSeries(argv);
  } catch (e) {
    if (e instanceof SeriesError) {
      console.error(`${e.message}\nusage: ${usage}`);
      process.exit(1);
    }
    throw e;
  }
}

export function promptMeta(profile: SeriesProfile, kind: "extraction" | "redescribe"): SeriesPromptMeta {
  return {
    id: profile.id,
    title: profile.title,
    author: profile.author,
    notes: kind === "extraction" ? profile.extraction.notes : profile.extraction.redescribeNotes,
  };
}

/** Throw unless the profile opts into an optional pipeline step. */
export function requireStep(profile: SeriesProfile, step: keyof SeriesProfile["steps"]): void {
  if (!profile.steps[step]) {
    throw new SeriesError(`series "${profile.id}" does not enable steps.${step} in series.json`);
  }
}
