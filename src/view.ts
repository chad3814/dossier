import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { materialize } from "./log.js";
import { renderMarkdown } from "./render.js";
import { resolveOutPath, resolveSeriesOrExit } from "./series.js";
import type { AliasEvent, DescriptionEvent, RegistryDelta } from "./types.js";

/** Parse `--flag value` pairs; returns a map of flag → value. */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      out[a.slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return out;
}

/**
 * Render the compendium as of a reading position:
 *   npm run view -- --series <id> [--through B2·C4] [--out path]
 * Reads the persisted per-book log under `<series>/log/`, materializes it to the
 * cutoff, and renders Markdown to stdout (or `--out`).
 */
function main(): void {
  const { paths, rest } = resolveSeriesOrExit(
    process.argv.slice(2),
    "npm run view -- --series <id> [--through B2·C4] [--out path]",
  );
  const args = parseArgs(rest);
  const logDir = paths.logDir;
  if (!existsSync(logDir)) {
    console.error(`view: ${logDir} not found — run "npm run migrate-to-log" first`);
    process.exit(1);
  }

  const files = readdirSync(logDir).filter((f) => /^delta-book\d+\.json$/.test(f));
  const deltas = files.map((f) => JSON.parse(readFileSync(join(logDir, f), "utf8")) as RegistryDelta);
  const descPath = join(logDir, "descriptions.json");
  const descriptions = existsSync(descPath)
    ? (JSON.parse(readFileSync(descPath, "utf8")) as DescriptionEvent[])
    : undefined;
  const aliasPath = join(logDir, "aliases.json");
  const aliases = existsSync(aliasPath)
    ? (JSON.parse(readFileSync(aliasPath, "utf8")) as AliasEvent[])
    : undefined;
  const registry = materialize(deltas, {}, { upTo: args.through || undefined, descriptions, aliases });
  const at = args.through ? `through ${args.through}` : "full series";

  if (args.out) {
    writeFileSync(resolveOutPath(paths, args.out), renderMarkdown(registry), "utf8");
    console.log(`view (${at}): ${registry.entities.length} entities -> ${args.out}`);
  } else {
    process.stdout.write(renderMarkdown(registry));
  }
}

main();
