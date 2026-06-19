import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BookManifest, BookSections, Registry } from "./types.js";

/** Pure: build the `books` field from a registry's processed books + a manifest lookup. */
export function buildBooksField(
  registry: Registry,
  manifestFor: (book: number) => { sections: Array<{ label: string }> },
  titleFor?: (book: number) => string | undefined,
): BookSections[] {
  return [...registry.booksProcessed]
    .sort((a, b) => a - b)
    .map((number) => {
      const title = titleFor?.(number);
      const sections = manifestFor(number).sections.map((s) => s.label);
      return title ? { number, title, sections } : { number, sections };
    });
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const registryPath = join(repoRoot, "..", "dcc", "output", "registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  const manifestFor = (book: number): BookManifest =>
    JSON.parse(readFileSync(join(repoRoot, "data", `book${book}`, "manifest.json"), "utf8")) as BookManifest;
  const titlesPath = join(repoRoot, "..", "dcc", "book-titles.json");
  let titleFor: ((book: number) => string | undefined) | undefined;
  if (existsSync(titlesPath)) {
    const arr = JSON.parse(readFileSync(titlesPath, "utf8")) as Array<{ number: number; title: string }>;
    const titles = new Map(arr.map((t) => [t.number, t.title]));
    titleFor = (book) => titles.get(book);
  }
  const books = buildBooksField(registry, manifestFor, titleFor);
  const next: Registry = { ...registry, books };
  writeFileSync(registryPath, JSON.stringify(next, null, 2), "utf8");
  console.log(`gen-structure: wrote books for ${books.length} books (${books.map((b) => b.number).join(", ")}).`);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
