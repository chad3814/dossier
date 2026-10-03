import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { parse } from "node-html-parser";
import { resolveSeriesOrExit } from "./series.js";
import type { SeriesProfile } from "./series.js";
import type { BookManifest, Chunk, EntryType, Section, SpineEntry } from "./types.js";

const FRONT_MATTER =
  /cover|title\s*page|copyright|dedication|table of contents|^contents$|colophon|acknowledg|about the author|also[-_ ]?by|backmatter|ad[-_]?card|teaser|newsletter|by the same author|glossary|^map( of\b.*)?$|image description|major characters|cast of characters|dramatis personae|endpaper|signup|recommendpage|longdesc|drm[-_ ]?notice/i;

const ROMAN = /^m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;
const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

/** Parse a well-formed Roman numeral (case-insensitive); null for anything else. */
export function romanToInt(s: string): number | null {
  const t = s.toLowerCase();
  if (t.length === 0 || !ROMAN.test(t)) return null;
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const cur = ROMAN_VALUES[t[i] as string] ?? 0;
    const next = ROMAN_VALUES[t[i + 1] ?? ""] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

/**
 * Classify a spine entry. EPUBs vary: some encode the kind in the manifest idref
 * (Book 1: `x_chapter-006`), others only in the document `<title>` (Book 2:
 * `<title>Chapter 1</title>`). We therefore look at the title text first, then
 * the idref, then the body's opening words.
 */
export function classifyEntry(
  idref: string,
  title = "",
  bodyStart = "",
): { type: EntryType; number: number | null } {
  const id = idref.toLowerCase();
  const t = title.toLowerCase().trim();
  const numIn = (s: string): number | null => {
    const m = s.match(/(\d+)/);
    return m ? Number.parseInt(m[1] as string, 10) : null;
  };

  // Chapter from the reliable signals (title text, then idref).
  const chap = t.match(/chapter\s+(\d+)/) ?? id.match(/chapter[^0-9]*(\d+)/);
  if (chap) return { type: "chapter", number: Number.parseInt(chap[1] as string, 10) };

  // Roman-numeral chapter titles ("Chapter XXV").
  const roman = t.match(/chapter\s+([ivxlcdm]+)\b/);
  if (roman) {
    const n = romanToInt(roman[1] as string);
    if (n !== null) return { type: "chapter", number: n };
  }

  for (const type of ["prologue", "interlude", "epilogue", "epigraph"] as const) {
    if (new RegExp(`\\b${type}\\b`, "i").test(t) || id.includes(type)) {
      return { type, number: numIn(t) ?? numIn(id) };
    }
  }

  // Part dividers: titled "Part I/One/1", or a roman-numeral prefix like "I. Havana".
  // Match the word "part" in the idref only with separators, so filename-style
  // idrefs such as "part0008" are NOT treated as Part dividers.
  if (/\bpart\b/i.test(t) || /^[ivxlcdm]+\.\s/i.test(t) || /[_-]part[_-]/.test(id)) {
    return { type: "part", number: numIn(t) ?? numIn(id) };
  }

  // Front-matter must be ruled out BEFORE the body-text fallback, since pages
  // like a Table of Contents open with the words "Chapter 1 Chapter 2 …".
  if (FRONT_MATTER.test(t) || FRONT_MATTER.test(id)) return { type: "front", number: null };

  // A bare ch<digits> idref ("ch25") counts only once every title-based signal has had its say:
  // publishers number every body file this way, including prologues and front matter.
  const chId = id.match(/^ch0*(\d+)$/);
  if (chId) return { type: "chapter", number: Number.parseInt(chId[1] as string, 10) };

  // Last resort: a chapter whose only signal is its opening words.
  const chapBody = bodyStart.toLowerCase().match(/^\W{0,4}chapter\s+(\d+)/);
  if (chapBody) return { type: "chapter", number: Number.parseInt(chapBody[1] as string, 10) };

  return { type: "other", number: null };
}

/** Base citation token for a section, before uniqueness suffixing. */
export function baseLabel(type: EntryType, num: number | null): string {
  switch (type) {
    case "chapter":
      return `C${num ?? "?"}`;
    case "part":
      return num === null ? "Part" : `Part${num}`;
    case "prologue":
      return "Prologue";
    case "interlude":
      return "Interlude";
    case "epilogue":
      return "Epilogue";
    case "epigraph":
      return "Epigraph";
    default:
      return "Sec";
  }
}

/** Parse the OPF spine into reading order, resolving idrefs to hrefs via the manifest. */
export function parseSpine(opfXml: string): SpineEntry[] {
  const root = parse(opfXml);
  const hrefById = new Map<string, string>();
  for (const item of root.querySelectorAll("item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) hrefById.set(id, href);
  }
  const entries: SpineEntry[] = [];
  for (const ref of root.querySelectorAll("itemref")) {
    const idref = ref.getAttribute("idref");
    if (!idref) continue;
    const href = hrefById.get(idref);
    if (href) entries.push({ idref, href });
  }
  return entries;
}

/**
 * Map each content file (by basename) to its authoritative title from the NCX
 * table of contents. The first navPoint referencing a file wins (the file's own
 * heading, not a nested sub-entry). This is the most reliable section label
 * across EPUBs whose idrefs or <title> tags are uninformative.
 */
export function parseTocTitles(ncxXml: string): Map<string, string> {
  // Regex rather than the HTML parser: the NCX is XML with camelCase tags
  // (navPoint, navLabel) that an HTML parser lowercases, breaking selectors.
  const map = new Map<string, string>();
  const re = /<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*\bsrc="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ncxXml)) !== null) {
    const text = (m[1] as string).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const base = (m[2] as string).split("#")[0]?.split("/").pop();
    if (text && base && !map.has(base)) map.set(base, text);
  }
  return map;
}

/**
 * Extract paragraph text from a chapter's XHTML.
 * Rule: every <p> element in document order whose trimmed text is non-empty,
 * with inner markup flattened and whitespace collapsed. This index is the
 * repeatable ¶ anchor.
 */
export function extractParagraphs(xhtml: string): string[] {
  const root = parse(xhtml);
  const out: string[] = [];
  for (const p of root.querySelectorAll("p")) {
    const text = p.textContent.replace(/\s+/g, " ").trim();
    if (text.length > 0) out.push(text);
  }
  return out;
}

/** Pull a human-readable title from an XHTML document (first heading, else <title>). */
function extractTitle(xhtml: string): string {
  const root = parse(xhtml);
  for (const sel of ["h1", "h2", "title"]) {
    const el = root.querySelector(sel);
    const text = el?.textContent.replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

/** The <title> element text plus first heading — the most reliable classification signal. */
function extractClassifierTitle(xhtml: string): string {
  const root = parse(xhtml);
  const parts: string[] = [];
  for (const sel of ["title", "h1", "h2"]) {
    const text = root.querySelector(sel)?.textContent.replace(/\s+/g, " ").trim();
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

/** Render a chunk as annotated plain text with [B·label·¶n] markers for the extraction agents. */
export function renderChunk(bookNumber: number, chunk: Chunk): string {
  const lines: string[] = [];
  for (const section of chunk.sections) {
    const titleSuffix = section.title ? ` — "${section.title}"` : "";
    lines.push(`### B${bookNumber}·${section.label}${titleSuffix}`);
    section.paragraphs.forEach((p, i) => {
      lines.push(`[B${bookNumber}·${section.label}·¶${i + 1}] ${p}`);
    });
    lines.push("");
  }
  return lines.join("\n");
}

export type PreprocessOptions = SeriesProfile["preprocess"];

const BOOK_SCOPE = /^B(\d+):(.+)$/;

/**
 * Resolve a series-wide preprocess profile for one book. Entries may be scoped with a
 * `B<n>:` prefix (`"B2:Map of the Catenan Republic"`, `"B1:part04_sub01"`): those apply to
 * book n only and are returned with the prefix stripped; unscoped entries apply to every book.
 * Scoping keeps the unmatched-entry warning honest when an appendix exists in one book only.
 */
export function scopeOptionsToBook(opts: PreprocessOptions, bookNumber: number): PreprocessOptions {
  const keep = (raw: string): string | null => {
    const m = BOOK_SCOPE.exec(raw);
    if (!m) return raw;
    return Number.parseInt(m[1] as string, 10) === bookNumber ? (m[2] as string) : null;
  };
  const excludeSections: string[] = [];
  for (const ex of opts.excludeSections) {
    const k = keep(ex);
    if (k !== null) excludeSections.push(k);
  }
  const sectionLabels: Record<string, string> = {};
  for (const [key, label] of Object.entries(opts.sectionLabels)) {
    const k = keep(key);
    if (k !== null) sectionLabels[k] = label;
  }
  return { excludeSections, sectionLabels };
}

/**
 * Decide whether a spine entry becomes a section and what its base label is.
 * Per-series exclusions run first (exact, case-insensitive on the section's display title —
 * the same title the manifest records — or its idref), then front-matter classification,
 * then an optional per-series label override by idref.
 */
export function planSection(
  entry: SpineEntry,
  spineIndex: number,
  title: string,
  classifierTitle: string,
  bodyStart: string,
  opts: PreprocessOptions,
): { include: false } | { include: true; type: EntryType; number: number | null; base: string } {
  const excluded = new Set(opts.excludeSections.map((s) => s.trim().toLowerCase()));
  if (excluded.has(title.trim().toLowerCase()) || excluded.has(entry.idref.trim().toLowerCase())) {
    return { include: false };
  }
  const { type, number } = classifyEntry(entry.idref, classifierTitle, bodyStart);
  if (type === "front") return { include: false };
  const override = opts.sectionLabels[entry.idref];
  const base = override ?? (type === "other" ? `Sec${spineIndex}` : baseLabel(type, number));
  return { include: true, type, number, base };
}

/**
 * Profile entries that matched no spine entry. Anchors are permanent once a book is
 * extracted, so a misspelled exclusion or label key must be loud, not silently ignored.
 */
export function unmatchedPreprocessEntries(
  opts: PreprocessOptions,
  seen: { titles: Iterable<string>; idrefs: Iterable<string> },
): string[] {
  const norm = (s: string): string => s.trim().toLowerCase();
  const titles = new Set([...seen.titles].map(norm));
  const idrefs = new Set([...seen.idrefs].map(norm));
  const out: string[] = [];
  for (const ex of opts.excludeSections) {
    if (!titles.has(norm(ex)) && !idrefs.has(norm(ex))) {
      out.push(`excludeSections: ${JSON.stringify(ex)} matched no spine entry (title or idref)`);
    }
  }
  for (const key of Object.keys(opts.sectionLabels)) {
    if (!idrefs.has(norm(key))) out.push(`sectionLabels: ${JSON.stringify(key)} matched no spine idref`);
  }
  return out;
}

/** Resolve the OPF path from the EPUB container, then build the ordered, included sections. */
function buildSections(zip: AdmZip, seriesOpts: PreprocessOptions, bookNumber: number): { sections: Section[]; warnings: string[] } {
  const opts = scopeOptionsToBook(seriesOpts, bookNumber);
  const containerXml = zip.readAsText("META-INF/container.xml");
  const opfPath = parse(containerXml).querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new Error("Could not locate OPF rootfile in container.xml");
  const opfDir = posix.dirname(opfPath);
  const opfXml = zip.readAsText(opfPath);
  const spine = parseSpine(opfXml);

  // Load the NCX table of contents (authoritative per-file titles), if present.
  let tocTitles = new Map<string, string>();
  const opfRoot = parse(opfXml);
  const ncxItem = opfRoot
    .querySelectorAll("item")
    .find((it) => it.getAttribute("media-type") === "application/x-dtbncx+xml");
  const ncxHref = ncxItem?.getAttribute("href");
  if (ncxHref) {
    const ncxPath = opfDir === "." ? ncxHref : posix.join(opfDir, ncxHref);
    try {
      tocTitles = parseTocTitles(zip.readAsText(ncxPath));
    } catch {
      tocTitles = new Map();
    }
  }
  const tocTitleFor = (href: string): string => tocTitles.get(href.split("/").pop() ?? href) ?? "";

  const usedLabels = new Map<string, number>();
  const uniqueLabel = (base: string): string => {
    const count = (usedLabels.get(base) ?? 0) + 1;
    usedLabels.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };

  const sections: Section[] = [];
  const seenTitles: string[] = [];
  const seenIdrefs: string[] = [];
  spine.forEach((entry, spineIndex) => {
    const fullPath = opfDir === "." ? entry.href : posix.join(opfDir, entry.href);
    const xhtml = zip.readAsText(fullPath);
    const paragraphs = extractParagraphs(xhtml);
    const bodyStart = paragraphs.slice(0, 2).join(" ").slice(0, 80);
    const tocTitle = tocTitleFor(entry.href);
    const classifierTitle = tocTitle || extractClassifierTitle(xhtml);
    const title = tocTitle || extractTitle(xhtml);
    seenTitles.push(title);
    seenIdrefs.push(entry.idref);
    const plan = planSection(entry, spineIndex, title, classifierTitle, bodyStart, opts);
    if (!plan.include) return;
    if (paragraphs.length === 0) return;
    sections.push({
      type: plan.type,
      label: uniqueLabel(plan.base),
      chapterNumber: plan.type === "chapter" ? plan.number : null,
      title,
      href: entry.href,
      paragraphs,
    });
  });
  return { sections, warnings: unmatchedPreprocessEntries(opts, { titles: seenTitles, idrefs: seenIdrefs }) };
}

/** True when `file` is `dir` itself or lies anywhere beneath it (lexically, after normalization). */
export function isInsideDir(dir: string, file: string): boolean {
  const rel = relative(resolve(dir), resolve(file));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function bookNumberFromPath(epubPath: string): number {
  const m = epubPath.match(/book\s*0*(\d+)/i);
  if (!m) throw new Error(`Could not infer book number from path: ${epubPath}`);
  return Number.parseInt(m[1] as string, 10);
}

function main(): void {
  const usage = "npm run preprocess -- --series <id> <bookNumber | path/to/book.epub>";
  const { paths, profile, rest } = resolveSeriesOrExit(process.argv.slice(2), usage);
  const arg = rest[0];
  if (!arg) {
    console.error(`usage: ${usage}`);
    process.exit(1);
  }
  const asNumber = /^\d+$/.test(arg) ? Number.parseInt(arg, 10) : null;
  const bookNumber = asNumber ?? bookNumberFromPath(arg);
  const epubPath = asNumber !== null ? paths.epub(asNumber) : resolve(arg);
  if (!isInsideDir(paths.epubsDir, epubPath)) {
    console.error(
      `preprocess: ${epubPath} is outside ${paths.epubsDir}. Copy the EPUB into the series' epubs/ directory first — ` +
        `anchors are tied to the exact file, so the one that was preprocessed must stay with the series.`,
    );
    process.exit(1);
  }

  const zip = new AdmZip(epubPath);
  const { sections, warnings } = buildSections(zip, profile.preprocess, bookNumber);
  for (const w of warnings) console.warn(`preprocess: WARNING ${w} — check ${paths.profile}`);

  const outDir = paths.bookDir(bookNumber);
  const sectionDir = paths.sectionsDir(bookNumber);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(sectionDir, { recursive: true });

  let totalWords = 0;
  const manifestSections = sections.map((s, i) => {
    const safeLabel = s.label.replace(/[^A-Za-z0-9_-]/g, "_");
    const file = `${String(i + 1).padStart(3, "0")}-${safeLabel}.txt`;
    const text = renderChunk(bookNumber, { index: i + 1, sections: [s], wordCount: 0 });
    writeFileSync(join(sectionDir, file), text, "utf8");
    totalWords += s.paragraphs.reduce((n, p) => n + p.split(/\s+/).length, 0);
    return {
      label: s.label,
      type: s.type,
      title: s.title,
      paragraphCount: s.paragraphs.length,
      file,
    };
  });

  const manifest: BookManifest = {
    bookNumber,
    sourceEpub: relative(paths.root, epubPath),
    sections: manifestSections,
    sectionCount: sections.length,
    totalWords,
  };
  writeFileSync(paths.manifest(bookNumber), JSON.stringify(manifest, null, 2), "utf8");

  console.log(
    `${paths.id} book${bookNumber}: ${sections.length} sections, ~${totalWords} words -> ${outDir}`,
  );
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
