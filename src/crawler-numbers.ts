import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanAliases, lookup } from "./registry.js";
import type { Registry } from "./types.js";

const Q = "[\"“”'‘’]";

/**
 * Extract `(number, name)` pairs from the System's crawler-designation lines.
 * Handles both the broadcast form (`Crawler #324,119. "Frank Q."`) and the
 * second-person designation form (`...Crawler Number 4,122. ...Crawler Name "Carl."`).
 */
export function extractCrawlerNumbers(text: string): Array<{ number: string; name: string }> {
  const out: Array<{ number: string; name: string }> = [];
  const seen = new Set<string>();
  const push = (number: string, rawName: string): void => {
    const name = rawName.trim().replace(/\.+$/, "").trim();
    const key = `${number}|${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ number: number.trim(), name });
  };

  const broadcast = new RegExp(`Crawler #([\\d,]+)\\.\\s*${Q}([^"“”'‘’]+)${Q}`, "g");
  const designation = new RegExp(
    `Crawler Number ([\\d,]+)\\.[\\s\\S]{0,120}?Crawler Name\\s*${Q}([^"“”'‘’]+)${Q}`,
    "g",
  );
  for (const re of [broadcast, designation]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) push(m[1] as string, m[2] as string);
  }
  return out;
}

/**
 * Attach `Crawler #<number>` aliases to the matching registry entities, using
 * the deterministic lookup to resolve each designated name. Returns how many
 * aliases were newly added.
 */
export function attachCrawlerNumbers(registry: Registry, texts: string[]): { attached: number } {
  let attached = 0;
  for (const text of texts) {
    for (const { number, name } of extractCrawlerNumbers(text)) {
      const target = lookup(registry, name)[0];
      if (!target) continue;
      const before = target.aliases.length;
      target.aliases = cleanAliases(target.canonicalName, [...target.aliases, `Crawler #${number}`]);
      if (target.aliases.length > before) attached++;
    }
  }
  return { attached };
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const registryPath = join(repoRoot, "output", "registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;

  const texts: string[] = [];
  for (const book of registry.booksProcessed) {
    const dir = join(repoRoot, "data", `book${book}`, "sections");
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".txt")) texts.push(readFileSync(join(dir, file), "utf8"));
    }
  }

  const { attached } = attachCrawlerNumbers(registry, texts);
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");
  console.log(`crawler-numbers: attached ${attached} Crawler #ID aliases across books ${registry.booksProcessed.join(", ")}`);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
