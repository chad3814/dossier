import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "./log.js";
import { renderMarkdown } from "./render.js";
import type { RegistryDelta } from "./types.js";

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
 *   npm run view -- --through B2·C4 [--series dcc] [--out path]
 * Reads the persisted per-book log under `<series>/log/`, materializes it to the
 * cutoff, and renders Markdown to stdout (or `--out`).
 */
function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = parseArgs(process.argv.slice(2));
  const seriesDir = join(here, "..", "..", args.series ?? "dcc");
  const logDir = join(seriesDir, "log");
  if (!existsSync(logDir)) {
    console.error(`view: ${logDir} not found — run "npm run migrate-to-log" first`);
    process.exit(1);
  }

  const files = readdirSync(logDir).filter((f) => /^delta-book\d+\.json$/.test(f));
  const deltas = files.map((f) => JSON.parse(readFileSync(join(logDir, f), "utf8")) as RegistryDelta);
  const registry = materialize(deltas, {}, { upTo: args.through || undefined });
  const at = args.through ? `through ${args.through}` : "full series";

  if (args.out) {
    writeFileSync(join(seriesDir, args.out), renderMarkdown(registry), "utf8");
    console.log(`view (${at}): ${registry.entities.length} entities -> ${args.out}`);
  } else {
    process.stdout.write(renderMarkdown(registry));
  }
}

main();
