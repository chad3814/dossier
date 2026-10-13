import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { anchorSortKey, buildSectionOrder, normalizeAnchor, readRegistryOrEmpty, type SectionOrder } from "./registry.js";
import { resolveSeriesOrExit } from "./series.js";
import type { AliasEvent, DescriptionEvent } from "./types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface RedescribeResult {
  bookNumber: number;
  descriptionEvents: DescriptionEvent[];
  aliasEvents: AliasEvent[];
}

/**
 * Flatten a re-describe workflow result (the runner's `{ result }` wrapper or the bare result,
 * chunked as `descriptionEventChunks` / `aliasEventChunks` for the VM array cap, or flat).
 * Anchors are normalized.
 */
export function flattenRedescribeResult(input: unknown): RedescribeResult {
  const r = isRecord(input) && isRecord(input.result) ? input.result : input;
  if (!isRecord(r) || typeof r.bookNumber !== "number") throw new Error("not a re-describe result (no bookNumber)");
  const flat = <T>(chunks: unknown, flatKey: unknown): T[] =>
    Array.isArray(chunks) ? (chunks as T[][]).flat() : Array.isArray(flatKey) ? (flatKey as T[]) : [];
  const descriptionEvents = flat<DescriptionEvent>(r.descriptionEventChunks, r.descriptionEvents);
  const aliasEvents = flat<AliasEvent>(r.aliasEventChunks, r.aliasEvents);
  if (descriptionEvents.length === 0) throw new Error("re-describe result has no description events");
  return {
    bookNumber: r.bookNumber,
    descriptionEvents: descriptionEvents.map((e) => ({ ...e, anchor: normalizeAnchor(e.anchor) })),
    aliasEvents: aliasEvents.map((e) => ({ ...e, anchor: normalizeAnchor(e.anchor) })),
  };
}

function bookOf(anchor: string): number {
  const m = /^B(\d+)·/.exec(anchor);
  return m?.[1] ? Number(m[1]) : NaN;
}

/**
 * Replace one book's events inside an existing log (so re-running a book is idempotent) and keep
 * the whole log in spine order. Ties keep their existing order (Array.sort is stable).
 */
export function mergeBookEvents<T extends { anchor: string }>(existing: T[], incoming: T[], book: number, order: SectionOrder): T[] {
  const kept = existing.filter((e) => bookOf(e.anchor) !== book);
  const keyed = [...kept, ...incoming].map((e) => ({ e, k: anchorSortKey(e.anchor, order) }));
  keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]);
  return keyed.map((x) => x.e);
}

function readArray<T>(path: string): T[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T[]) : [];
}

function main(): void {
  const usage = "npm run save-events -- --series <id> <workflow-output.json>";
  const { paths, rest } = resolveSeriesOrExit(process.argv.slice(2), usage);
  const inputArg = rest[0];
  if (!inputArg) {
    console.error(`usage: ${usage}`);
    process.exit(1);
  }
  const result = flattenRedescribeResult(JSON.parse(readFileSync(resolve(inputArg), "utf8")));
  const order = buildSectionOrder(readRegistryOrEmpty(paths.registry).books);
  const descPath = join(paths.logDir, "descriptions.json");
  const rawPath = join(paths.logDir, "aliases.raw.json");
  const descriptions = mergeBookEvents(readArray<DescriptionEvent>(descPath), result.descriptionEvents, result.bookNumber, order);
  const aliases = mergeBookEvents(readArray<AliasEvent>(rawPath), result.aliasEvents, result.bookNumber, order);
  writeFileSync(descPath, JSON.stringify(descriptions, null, 2) + "\n", "utf8");
  writeFileSync(rawPath, JSON.stringify(aliases, null, 2) + "\n", "utf8");
  console.log(
    `save-events: book ${result.bookNumber} — ${result.descriptionEvents.length} description events, ${result.aliasEvents.length} alias events ` +
      `(log now ${descriptions.length} / ${aliases.length})`,
  );
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
