import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EntityType, Registry, RegistryEntity } from "./types.js";

const TYPE_LABEL: Record<EntityType, string> = {
  person: "Person",
  creature: "Creature",
  faction: "Faction/Group",
  ai_system: "AI / System",
  place: "Place",
  other: "Other",
};

const SIGNIFICANCE_ORDER = ["major", "supporting", "minor", "mentioned"];

/**
 * Collapse a flat anchor list into a compact per-section view:
 * ["B1·C1·¶1","B1·C1·¶4","B1·C2·¶3"] -> "B1 · C1 ¶1, 4 · C2 ¶3".
 * Anchors are assumed pre-sorted into reading order.
 */
export function groupAnchors(anchors: string[]): string {
  const books: Array<{ book: string; sections: Array<{ label: string; paras: string[] }> }> = [];
  for (const anchor of anchors) {
    const parts = anchor.split("·");
    const book = parts[0] ?? "";
    const label = parts[1] ?? anchor;
    const paraMatch = (parts[2] ?? "").match(/(\d+)/);
    const para = paraMatch ? (paraMatch[1] as string) : "?";
    let bookGroup = books[books.length - 1];
    if (!bookGroup || bookGroup.book !== book) {
      bookGroup = { book, sections: [] };
      books.push(bookGroup);
    }
    const last = bookGroup.sections[bookGroup.sections.length - 1];
    if (last && last.label === label) last.paras.push(para);
    else bookGroup.sections.push({ label, paras: [para] });
  }
  return books
    .map((b) => `${b.book} · ${b.sections.map((s) => `${s.label} ¶${s.paras.join(", ")}`).join(" · ")}`)
    .join("  ||  ");
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function renderEntity(e: RegistryEntity): string {
  const lines: string[] = [];
  lines.push(`### ${e.canonicalName}`);
  const meta = [
    `*${TYPE_LABEL[e.type]}*`,
    `**${e.significance}**`,
    e.tags.join(", "),
    `${e.appearances.length} mentions`,
  ];
  lines.push(meta.join(" · "));
  if (e.aliases.length > 0) lines.push(`**Also known as:** ${e.aliases.join(", ")}`);
  if (e.description) lines.push(e.description);
  if (e.firstAppearance) {
    lines.push(`**First appears:** \`${e.firstAppearance.anchor}\` — "${e.firstAppearance.snippet}"`);
  }
  if (e.appearances.length > 0) lines.push(`**Appears:** ${groupAnchors(e.appearances)}`);
  return lines.join("\n\n");
}

/** Render the full Markdown compendium from the cross-book registry. */
export function renderMarkdown(registry: Registry): string {
  const books = registry.booksProcessed.join(", ");
  const entities = [...registry.entities].sort((a, b) => {
    const sig = SIGNIFICANCE_ORDER.indexOf(a.significance) - SIGNIFICANCE_ORDER.indexOf(b.significance);
    if (sig !== 0) return sig;
    return a.canonicalName.localeCompare(b.canonicalName);
  });

  const out: string[] = [];
  out.push(`# Dungeon Crawler Carl — Character Compendium`);
  out.push(
    `_${registry.entities.length} named entities across Book(s) ${books}. ` +
      `Anchors are \`B<book>·<section>·¶<paragraph>\` into the source EPUBs._`,
  );

  const sig = new Map<string, number>();
  const tag = new Map<string, number>();
  const type = new Map<string, number>();
  for (const e of registry.entities) {
    sig.set(e.significance, (sig.get(e.significance) ?? 0) + 1);
    type.set(e.type, (type.get(e.type) ?? 0) + 1);
    for (const t of e.tags) tag.set(t, (tag.get(t) ?? 0) + 1);
  }
  out.push(
    `**Significance:** ${SIGNIFICANCE_ORDER.filter((s) => sig.has(s)).map((s) => `${sig.get(s)} ${s}`).join(" · ")}`,
  );
  out.push(`**Tags:** ${[...tag].map(([t, n]) => `${n} ${t}`).join(" · ")}`);
  out.push(`**Types:** ${[...type].map(([t, n]) => `${n} ${TYPE_LABEL[t as EntityType]}`).join(" · ")}`);

  out.push("## Index");
  out.push(
    [...registry.entities]
      .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName))
      .map((e) => `- [${e.canonicalName}](#${slug(e.canonicalName)}) — ${TYPE_LABEL[e.type]}, ${e.significance}`)
      .join("\n"),
  );

  out.push("## Characters");
  for (const e of entities) out.push(renderEntity(e));

  return out.join("\n\n") + "\n";
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const inArg = process.argv[2] ?? "output/registry.json";
  const inPath = join(repoRoot, inArg);
  const registry = JSON.parse(readFileSync(inPath, "utf8")) as Registry;
  const outPath = process.argv[3] ? join(repoRoot, process.argv[3]) : join(repoRoot, "output", "characters.md");
  writeFileSync(outPath, renderMarkdown(registry), "utf8");
  console.log(`Rendered ${registry.entities.length} entities -> ${outPath}`);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
