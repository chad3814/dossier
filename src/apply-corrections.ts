import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDroppableAlias } from "./alias-clean.js";
import { normalizeName } from "./registry.js";
import type { AliasEvent, DescriptionEvent, Registry, RegistryEntity } from "./types.js";

export interface Corrections {
  dropAliases?: Array<{ id: string; alias: string }>;
  reassignAliases?: Array<{ from: string; to: string; alias: string }>;
  merges?: Array<{ from: string; into: string }>;
}

export interface ApplyInput {
  registry: Registry;
  aliases: AliasEvent[];
  descriptions: DescriptionEvent[];
  corrections: Corrections;
}

export interface ApplyOutput {
  registry: Registry;
  aliases: AliasEvent[];
  descriptions: DescriptionEvent[];
}

/** Deep-clone a plain JSON-serializable value. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** True when `candidate` matches `target` under normalizeName. */
function aliasMatches(candidate: string, target: string): boolean {
  return normalizeName(candidate) === normalizeName(target);
}

/**
 * Add `alias` to `entity.aliases` if no existing alias already normalizes the same way.
 * Mutates `entity`.
 */
function addAliasIfAbsent(entity: RegistryEntity, alias: string): void {
  const norm = normalizeName(alias);
  const already = entity.aliases.some((a) => normalizeName(a) === norm);
  if (!already) {
    entity.aliases.push(alias);
  }
}

/**
 * Pure function: apply a corrections file to registry + event logs.
 *
 * Apply order:
 *   1. Blob-clean: strip droppable aliases (noise, possessives) from every entity.
 *   2. dropAliases: remove named aliases from entity blob + alias events.
 *   3. reassignAliases: move alias from one entity's blob to another, rewrite alias events.
 *   4. merges: fold `from` into `into` (appearances, aliases, canonicalName as alias),
 *              remap `from`->`into` in alias + description events, remove `from` entity.
 */
export function applyCorrections(input: ApplyInput): ApplyOutput {
  const registry: Registry = clone(input.registry);
  const aliases: AliasEvent[] = clone(input.aliases);
  const descriptions: DescriptionEvent[] = clone(input.descriptions);
  const { corrections } = input;

  const byId = new Map<string, RegistryEntity>(
    registry.entities.map((e) => [e.id, e]),
  );

  // Step 1: blob-clean every entity
  for (const entity of registry.entities) {
    entity.aliases = entity.aliases.filter((a) => !isDroppableAlias(a, entity));
  }

  // Step 2: drop aliases (blob + alias events)
  for (const { id, alias } of corrections.dropAliases ?? []) {
    const entity = byId.get(id);
    if (entity) {
      entity.aliases = entity.aliases.filter((a) => !aliasMatches(a, alias));
    }
    // Remove matching alias events
    for (let i = aliases.length - 1; i >= 0; i--) {
      const ev = aliases[i];
      if (ev !== undefined && ev.id === id && aliasMatches(ev.alias, alias)) {
        aliases.splice(i, 1);
      }
    }
  }

  // Step 3: reassign aliases (blob + alias events)
  for (const { from, to, alias } of corrections.reassignAliases ?? []) {
    const fromEntity = byId.get(from);
    const toEntity = byId.get(to);
    if (fromEntity) {
      fromEntity.aliases = fromEntity.aliases.filter((a) => !aliasMatches(a, alias));
    }
    if (toEntity) {
      addAliasIfAbsent(toEntity, alias);
    }
    // Rewrite matching alias events: change id from -> to
    for (const ev of aliases) {
      if (ev.id === from && aliasMatches(ev.alias, alias)) {
        ev.id = to;
      }
    }
  }

  // Step 4: merges
  for (const { from, into } of corrections.merges ?? []) {
    const fromEntity = byId.get(from);
    const intoEntity = byId.get(into);
    // Idempotent: if `from` no longer exists, skip
    if (!fromEntity || !intoEntity) continue;

    // Append appearances (deduped)
    for (const ap of fromEntity.appearances) {
      if (!intoEntity.appearances.includes(ap)) {
        intoEntity.appearances.push(ap);
      }
    }

    // Append aliases from `from` blob (deduped by normalizeName)
    for (const a of fromEntity.aliases) {
      addAliasIfAbsent(intoEntity, a);
    }

    // Add `from`'s canonicalName as an alias on `into` (deduped)
    addAliasIfAbsent(intoEntity, fromEntity.canonicalName);

    // Remap alias events: from -> into
    for (const ev of aliases) {
      if (ev.id === from) {
        ev.id = into;
      }
    }

    // Remap description events: from -> into
    for (const ev of descriptions) {
      if (ev.id === from) {
        ev.id = into;
      }
    }

    // Remove `from` entity
    byId.delete(from);
    registry.entities = registry.entities.filter((e) => e.id !== from);
  }

  return { registry, aliases, descriptions };
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const dccRoot = join(repoRoot, "..", "dcc");

  const registryPath = join(dccRoot, "output", "registry.json");
  const aliasesPath = join(dccRoot, "log", "aliases.json");
  const descriptionsPath = join(dccRoot, "log", "descriptions.json");
  const correctionsPath = join(dccRoot, "corrections.json");

  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  const aliases = JSON.parse(readFileSync(aliasesPath, "utf8")) as AliasEvent[];
  const descriptions = JSON.parse(readFileSync(descriptionsPath, "utf8")) as DescriptionEvent[];
  const corrections = JSON.parse(readFileSync(correctionsPath, "utf8")) as Corrections;

  const out = applyCorrections({ registry, aliases, descriptions, corrections });

  writeFileSync(registryPath, JSON.stringify(out.registry, null, 2) + "\n", "utf8");
  writeFileSync(aliasesPath, JSON.stringify(out.aliases, null, 2) + "\n", "utf8");
  writeFileSync(descriptionsPath, JSON.stringify(out.descriptions, null, 2) + "\n", "utf8");

  console.log("apply-corrections: done.");
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
