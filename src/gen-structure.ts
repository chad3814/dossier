import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BookManifest, BookSections, Registry } from "./types.js";

/** Pure: build the `books` field from a registry's processed books + a manifest lookup. */
export function buildBooksField(
  registry: Registry,
  manifestFor: (book: number) => { sections: Array<{ label: string }> },
): BookSections[] {
  return [...registry.booksProcessed]
    .sort((a, b) => a - b)
    .map((number) => ({ number, sections: manifestFor(number).sections.map((s) => s.label) }));
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const registryPath = join(repoRoot, "..", "dcc", "output", "registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  const manifestFor = (book: number): BookManifest =>
    JSON.parse(readFileSync(join(repoRoot, "data", `book${book}`, "manifest.json"), "utf8")) as BookManifest;
  const books = buildBooksField(registry, manifestFor);
  const next: Registry = { ...registry, books };
  writeFileSync(registryPath, JSON.stringify(next, null, 2), "utf8");
  console.log(`gen-structure: wrote books for ${books.length} books (${books.map((b) => b.number).join(", ")}).`);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
