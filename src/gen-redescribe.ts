import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chapterEntities } from "./log.js";
import { isNoiseAlias } from "./reconcile-aliases.js";
import { anchorSortKey, normalizeAnchor } from "./registry.js";
import type { BookManifest, DescriptionEvent, EntityType, RegistryDelta } from "./types.js";

function cmp(a: string, b: string): number {
  const ka = anchorSortKey(a);
  const kb = anchorSortKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
}

interface RedescribeInput {
  bookNumber: number;
  manifestSections: Array<{ label: string; file: string }>;
  chapterMap: Map<string, Array<{ id: string; anchor: string }>>;
  index: Array<{ id: string; canonicalName: string; type: EntityType }>;
  priorEvents: DescriptionEvent[];
  aliasesById: Record<string, string[]>;
}

interface RedescribeConstants {
  bookNumber: number;
  chapters: Array<{
    file: string;
    label: string;
    entities: Array<{ id: string; anchor: string }>;
  }>;
  entityMeta: Record<string, { canonicalName: string; type: EntityType }>;
  seed: Record<string, { description: string; significance: string }>;
  aliasesById: Record<string, string[]>;
}

/**
 * Assemble the per-book constants for the chapter-sequential re-describe workflow:
 * chapters in manifest (reading) order, each with the entities appearing there (from the
 * Phase-1 log) and their first anchor in that chapter; plus a seed mapping each entity to
 * its latest description from prior books. Pure — unit-tested.
 */
export function buildRedescribeConstants(input: RedescribeInput): RedescribeConstants {
  const metaById = new Map(input.index.map((e) => [e.id, e]));
  const chapters = input.manifestSections.map((s) => {
    const key = `B${input.bookNumber}·${s.label}`;
    const entities = (input.chapterMap.get(key) ?? [])
      .filter((e) => metaById.has(e.id))
      .map((e) => ({ id: e.id, anchor: e.anchor }));
    return { file: s.file, label: s.label, entities };
  });

  // Scope everything to entities that actually appear in this book — the workflow never reads
  // others, and injecting all of them blows the Workflow script-size limit. Entity metadata is
  // injected once as a map (not repeated per appearance) for the same reason.
  const appearing = new Set<string>();
  for (const c of chapters) for (const e of c.entities) appearing.add(e.id);

  const entityMeta: Record<string, { canonicalName: string; type: EntityType }> = {};
  for (const id of appearing) {
    const m = metaById.get(id);
    if (m) entityMeta[id] = { canonicalName: m.canonicalName, type: m.type };
  }

  const latest = new Map<string, DescriptionEvent>();
  for (const ev of input.priorEvents) {
    const cur = latest.get(ev.id);
    if (!cur || cmp(normalizeAnchor(ev.anchor), normalizeAnchor(cur.anchor)) > 0) latest.set(ev.id, ev);
  }
  // Seed carries the prior description only as CONTEXT (so the agent can judge material change);
  // truncate it to keep the injected workflow script under the harness size limit. The emitted
  // descriptions are full — only this context copy is shortened.
  const seed: Record<string, { description: string; significance: string }> = {};
  for (const [id, ev] of latest) if (appearing.has(id)) seed[id] = { description: ev.description.slice(0, 400), significance: ev.significance };

  const aliasesById: Record<string, string[]> = {};
  for (const id of appearing) if (input.aliasesById[id]) aliasesById[id] = input.aliasesById[id];

  return { bookNumber: input.bookNumber, chapters, entityMeta, seed, aliasesById };
}

const START = "// ===== per-book constants";
const END = "// ===================================================";

/** Replace the constants block in the workflow template source. */
export function injectConstants(src: string, constants: string): string {
  const s = src.indexOf(START);
  const e = src.indexOf(END, s);
  if (s === -1 || e === -1) throw new Error("Could not find constants markers in redescribe template");
  return src.slice(0, s) + constants + src.slice(e + END.length);
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const bookNumber = Number.parseInt(process.argv[2] ?? "", 10);
  if (!Number.isFinite(bookNumber)) {
    console.error("usage: tsx src/gen-redescribe.ts <bookNumber>");
    process.exit(1);
  }

  const seriesLog = join(repoRoot, "..", "dcc", "log");
  const deltas = readdirSync(seriesLog)
    .filter((f) => /^delta-book\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(seriesLog, f), "utf8")) as RegistryDelta);
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "data", `book${bookNumber}`, "manifest.json"), "utf8"),
  ) as BookManifest;
  const index = deltas.flatMap((d) => d.newEntities.map((e) => ({ id: e.id, canonicalName: e.canonicalName, type: e.type })));

  let priorEvents: DescriptionEvent[] = [];
  try {
    const all = JSON.parse(readFileSync(join(seriesLog, "descriptions.json"), "utf8")) as DescriptionEvent[];
    priorEvents = all.filter((ev) => anchorSortKey(ev.anchor)[0] < bookNumber);
  } catch {
    priorEvents = [];
  }

  const aliasesById = Object.fromEntries(
    deltas.flatMap((d) => d.newEntities).map((e) => [e.id, e.aliases.filter((a) => !isNoiseAlias(a))]),
  );
  const constants = buildRedescribeConstants({
    bookNumber,
    manifestSections: manifest.sections.map((s) => ({ label: s.label, file: s.file })),
    chapterMap: chapterEntities(deltas),
    index,
    priorEvents,
    aliasesById,
  });

  const sectionDir = join(repoRoot, "data", `book${bookNumber}`, "sections");
  const block = [
    `${START} (generated by gen-redescribe.ts) =====`,
    `const bookNumber = ${bookNumber};`,
    `const sectionDir = ${JSON.stringify(sectionDir)};`,
    `const chapters = ${JSON.stringify(constants.chapters)};`,
    `const entityMeta = ${JSON.stringify(constants.entityMeta)};`,
    `const seed = ${JSON.stringify(constants.seed)};`,
    `const aliasesById = ${JSON.stringify(constants.aliasesById)};`,
    END,
  ].join("\n");

  const wfDir = join(repoRoot, "data", "_wf");
  mkdirSync(wfDir, { recursive: true });
  const dest = join(wfDir, "redescribe-book.js");
  copyFileSync(join(repoRoot, "workflow", "redescribe-book.js"), dest);
  writeFileSync(dest, injectConstants(readFileSync(dest, "utf8"), block), "utf8");

  const total = constants.chapters.reduce((n, c) => n + c.entities.length, 0);
  console.log(
    `gen-redescribe: book ${bookNumber} — ${constants.chapters.length} chapters, ${total} entity-appearances, ` +
      `seeded ${Object.keys(constants.seed).length} prior descriptions -> ${dest}`,
  );
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
