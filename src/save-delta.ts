import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAnchor, readRegistryOrEmpty } from "./registry.js";
import { resolveSeriesOrExit } from "./series.js";
import type { RegistryDelta, RegistryEntity } from "./types.js";

type Matched = RegistryDelta["matched"][number];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The anchor as the workflow agents may return it (sometimes with the file's square brackets). */
function cleanAnchor(a: string): string {
  return normalizeAnchor(a.replace(/^\[|\]$/g, ""));
}

/**
 * Turn a workflow extraction result into a RegistryDelta. Accepts the runner's persisted
 * wrapper (`{ result: … }`) or the bare result, in either the chunked shape the template
 * returns (`matchedChunks` / `newEntityChunks`, each ≤ 4000 items for the VM boundary) or the
 * older flat shape. Anchors are normalized and stripped of brackets.
 */
export function flattenWorkflowResult(input: unknown): RegistryDelta {
  const r = isRecord(input) && isRecord(input.result) ? input.result : input;
  if (!isRecord(r) || !Array.isArray(r.booksProcessed)) throw new Error("not a workflow extraction result (no booksProcessed)");
  const matchedRaw = Array.isArray(r.matchedChunks) ? (r.matchedChunks as Matched[][]).flat() : Array.isArray(r.matched) ? (r.matched as Matched[]) : null;
  const newRaw = Array.isArray(r.newEntityChunks) ? (r.newEntityChunks as RegistryEntity[][]).flat() : Array.isArray(r.newEntities) ? (r.newEntities as RegistryEntity[]) : null;
  if (!matchedRaw || !newRaw) throw new Error("not a workflow extraction result (no matched/newEntities)");
  return {
    booksProcessed: r.booksProcessed as number[],
    matched: matchedRaw.map((m) => ({ id: m.id, anchor: cleanAnchor(m.anchor), aliases: m.aliases ?? [] })),
    newEntities: newRaw.map((e) => ({
      ...e,
      appearances: e.appearances.map(cleanAnchor),
      firstAppearance: e.firstAppearance ? { ...e.firstAppearance, anchor: cleanAnchor(e.firstAppearance.anchor) } : null,
    })),
  };
}

export interface DeltaValidation {
  book: number;
  badAnchors: string[];
  unknownMatchedIds: string[];
  duplicateNewIds: string[];
  collidingNewIds: string[];
  matchedToPrior: number;
  ok: boolean;
}

/**
 * Structural checks before a delta is folded in: every anchor must appear verbatim (bracketed)
 * in the book's section text; every matched id must be a prior entity or a new one; new ids
 * must be unique and must not collide with prior ids.
 */
export function validateDelta(delta: RegistryDelta, sectionText: string, priorIds: ReadonlySet<string>): DeltaValidation {
  const book = Math.max(...delta.booksProcessed);
  const newIds = delta.newEntities.map((e) => e.id);
  const newIdSet = new Set(newIds);
  const anchors = new Set<string>([
    ...delta.matched.map((m) => m.anchor),
    ...delta.newEntities.flatMap((e) => e.appearances),
    ...delta.newEntities.flatMap((e) => (e.firstAppearance ? [e.firstAppearance.anchor] : [])),
  ]);
  const badAnchors = [...anchors].filter((a) => !sectionText.includes(`[${a}]`));
  const unknownMatchedIds = [...new Set(delta.matched.filter((m) => !priorIds.has(m.id) && !newIdSet.has(m.id)).map((m) => m.id))];
  const duplicateNewIds = [...new Set(newIds.filter((id, i) => newIds.indexOf(id) !== i))];
  const collidingNewIds = [...new Set(newIds.filter((id) => priorIds.has(id)))];
  const matchedToPrior = delta.matched.filter((m) => priorIds.has(m.id)).length;
  return {
    book,
    badAnchors,
    unknownMatchedIds,
    duplicateNewIds,
    collidingNewIds,
    matchedToPrior,
    ok: badAnchors.length === 0 && unknownMatchedIds.length === 0 && duplicateNewIds.length === 0 && collidingNewIds.length === 0,
  };
}

/**
 * Remove mentions whose anchor does not exist in the section text (agents occasionally emit an
 * off-by-one paragraph). Refuses — by throwing — to strip a new entity of its last anchor or of
 * its firstAppearance, since that would need a human decision rather than a silent drop.
 */
export function dropInvalidAnchors(delta: RegistryDelta, sectionText: string): { delta: RegistryDelta; dropped: string[] } {
  const ok = (a: string): boolean => sectionText.includes(`[${a}]`);
  const dropped: string[] = [];
  const matched = delta.matched.filter((m) => {
    if (ok(m.anchor)) return true;
    dropped.push(`${m.id}@${m.anchor}`);
    return false;
  });
  const newEntities = delta.newEntities.map((e) => {
    const appearances = e.appearances.filter((a) => {
      if (ok(a)) return true;
      dropped.push(`${e.id}@${a}`);
      return false;
    });
    if (appearances.length === 0) throw new Error(`cannot drop every anchor of new entity ${e.id}`);
    if (e.firstAppearance && !ok(e.firstAppearance.anchor)) throw new Error(`firstAppearance of new entity ${e.id} (${e.firstAppearance.anchor}) is not in the text`);
    return { ...e, appearances };
  });
  return { delta: { ...delta, matched, newEntities }, dropped };
}

function main(): void {
  const usage = "npm run save-delta -- --series <id> [--drop-invalid-anchors] <workflow-output.json>";
  const { paths, rest } = resolveSeriesOrExit(process.argv.slice(2), usage);
  const dropInvalid = rest.includes("--drop-invalid-anchors");
  const inputArg = rest.filter((a) => a !== "--drop-invalid-anchors")[0];
  if (!inputArg) {
    console.error(`usage: ${usage}`);
    process.exit(1);
  }
  let delta = flattenWorkflowResult(JSON.parse(readFileSync(resolve(inputArg), "utf8")));
  const book = Math.max(...delta.booksProcessed);
  const sectionsDir = paths.sectionsDir(book);
  if (!existsSync(sectionsDir)) {
    console.error(`save-delta: ${sectionsDir} not found — run preprocess for book ${book} first`);
    process.exit(1);
  }
  const sectionText = readdirSync(sectionsDir).map((f) => readFileSync(join(sectionsDir, f), "utf8")).join("\n");
  if (dropInvalid) {
    const r = dropInvalidAnchors(delta, sectionText);
    delta = r.delta;
    if (r.dropped.length) console.warn(`save-delta: dropped ${r.dropped.length} mention(s) with anchors not in the text: ${r.dropped.join(", ")}`);
  }
  const registry = readRegistryOrEmpty(paths.registry);
  const v = validateDelta(delta, sectionText, new Set(registry.entities.map((e) => e.id)));

  const pct = delta.matched.length ? Math.round((100 * v.matchedToPrior) / delta.matched.length) : 0;
  console.log(
    `save-delta: book ${book} — ${delta.newEntities.length} new entities, ${delta.matched.length} matched mentions ` +
      `(${pct}% to prior entities), ${new Set([...delta.matched.map((m) => m.anchor), ...delta.newEntities.flatMap((e) => e.appearances)]).size} distinct anchors`,
  );
  const problems = [
    v.badAnchors.length && `${v.badAnchors.length} anchor(s) not in section text, e.g. ${v.badAnchors.slice(0, 3).join(", ")}`,
    v.unknownMatchedIds.length && `matched ids unknown: ${v.unknownMatchedIds.slice(0, 5).join(", ")}`,
    v.duplicateNewIds.length && `duplicate new ids: ${v.duplicateNewIds.slice(0, 5).join(", ")}`,
    v.collidingNewIds.length && `new ids colliding with prior ids: ${v.collidingNewIds.slice(0, 5).join(", ")}`,
  ].filter(Boolean);
  for (const p of problems) console.error(`save-delta: ERROR ${p}`);
  if (!v.ok) process.exit(1);

  const out = join(paths.wfDir, `delta-book${book}.json`);
  writeFileSync(out, JSON.stringify(delta, null, 2), "utf8");
  console.log(`save-delta: wrote ${out}`);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
