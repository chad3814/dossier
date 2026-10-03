import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveSeriesOrExit } from "./series.js";
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
  const { paths, profile } = resolveSeriesOrExit(process.argv.slice(2), "npm run gen-structure -- --series <id>");
  const registry = JSON.parse(readFileSync(paths.registry, "utf8")) as Registry;
  const manifestFor = (book: number): BookManifest =>
    JSON.parse(readFileSync(paths.manifest(book), "utf8")) as BookManifest;
  const titles = new Map(profile.books.map((b) => [b.number, b.title]));
  const books = buildBooksField(registry, manifestFor, (book) => titles.get(book));
  const next: Registry = { ...registry, books };
  writeFileSync(paths.registry, JSON.stringify(next, null, 2), "utf8");
  console.log(`gen-structure: wrote books for ${books.length} books (${books.map((b) => b.number).join(", ")}).`);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
