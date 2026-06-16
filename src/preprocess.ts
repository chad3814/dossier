import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { parse } from "node-html-parser";
import type { BookManifest, Chunk, EntryType, Section, SpineEntry } from "./types.js";

const FRONT_MATTER =
  /cover|title\s*page|copyright|dedication|table of contents|^contents$|colophon|acknowledg|about the author|also[-_ ]?by|backmatter|ad[-_]?card|teaser|newsletter|by the same author/i;

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

/** Resolve the OPF path from the EPUB container, then build the ordered, included sections. */
function buildSections(zip: AdmZip): Section[] {
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
  spine.forEach((entry, spineIndex) => {
    const fullPath = opfDir === "." ? entry.href : posix.join(opfDir, entry.href);
    const xhtml = zip.readAsText(fullPath);
    const paragraphs = extractParagraphs(xhtml);
    const bodyStart = paragraphs.slice(0, 2).join(" ").slice(0, 80);
    const tocTitle = tocTitleFor(entry.href);
    const classifierTitle = tocTitle || extractClassifierTitle(xhtml);
    const { type, number } = classifyEntry(entry.idref, classifierTitle, bodyStart);
    if (type === "front") return;
    if (paragraphs.length === 0) return;
    const base = type === "other" ? `Sec${spineIndex}` : baseLabel(type, number);
    sections.push({
      type,
      label: uniqueLabel(base),
      chapterNumber: type === "chapter" ? number : null,
      title: tocTitle || extractTitle(xhtml),
      href: entry.href,
      paragraphs,
    });
  });
  return sections;
}

function bookNumberFromPath(epubPath: string): number {
  const m = epubPath.match(/book\s*0*(\d+)/i);
  if (!m) throw new Error(`Could not infer book number from path: ${epubPath}`);
  return Number.parseInt(m[1] as string, 10);
}

function main(): void {
  const epubArg = process.argv[2];
  if (!epubArg) {
    console.error("usage: tsx src/preprocess.ts <book.epub>");
    process.exit(1);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const epubPath = join(repoRoot, epubArg);
  const bookNumber = bookNumberFromPath(epubArg);

  const zip = new AdmZip(epubPath);
  const sections = buildSections(zip);

  const outDir = join(repoRoot, "data", `book${bookNumber}`);
  const sectionDir = join(outDir, "sections");
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
    sourceEpub: epubArg,
    sections: manifestSections,
    sectionCount: sections.length,
    totalWords,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log(
    `book${bookNumber}: ${sections.length} sections, ~${totalWords} words -> ${outDir}`,
  );
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
