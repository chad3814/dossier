import type { RegistryEntity } from "./types.js";

/** Bare pronouns/articles + interrogative/relative words that are never real name-forms. */
const NOISE = new Set([
  "i", "me", "my", "mine", "myself",
  "he", "him", "his", "himself",
  "she", "her", "hers", "herself",
  "they", "them", "their", "theirs", "themselves",
  "it", "its", "itself",
  "we", "us", "our", "ours", "you", "your", "yours",
  "the", "a", "an", "that", "this", "those", "these",
  "who", "whom", "whose", "what", "which", "where", "when", "there", "here",
]);

/** Lowercase, strip apostrophes (straight + curly), collapse non-alphanumerics to spaces. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\u0027\u2018\u2019\u02BC]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** True for a bare stopword alias (a single pronoun/article/interrogative). */
export function isNoiseAlias(alias: string): boolean {
  const n = norm(alias);
  return n.length === 0 || NOISE.has(n);
}

/** Name forms used to detect possessives: canonical name + its non-stopword tokens + single-word clean aliases. */
export function nameFormsOf(entity: RegistryEntity): string[] {
  const forms = new Set<string>([entity.canonicalName]);
  for (const tok of entity.canonicalName.split(/\s+/)) {
    if (!isNoiseAlias(tok) && norm(tok).length >= 3) forms.add(tok);
  }
  for (const a of entity.aliases) {
    if (!a.includes(" ") && !isNoiseAlias(a) && norm(a).length >= 3) forms.add(a);
  }
  return [...forms];
}

/** True when `alias` is (or begins with) a possessive of one of `nameForms`. */
export function isPossessiveOfName(alias: string, nameForms: string[]): boolean {
  const a = norm(alias);
  return nameForms.some((f) => {
    const nf = norm(f);
    return nf.length >= 2 && (a === `${nf}s` || a.startsWith(`${nf}s `));
  });
}

/**
 * How aggressively aliases are cleaned for a series (series.json `aliasPolicy`):
 * - "default": bare noise + possessives of the entity's own name (DCC/Hierarchy behaviour).
 * - "names-only": additionally drop descriptive phrases and kinship references.
 */
export type AliasPolicy = "default" | "names-only";

const DETERMINERS = new Set(["the", "a", "an", "my", "your", "his", "her", "its", "their", "our", "this", "that", "these", "those"]);

/**
 * A determiner-led phrase that is a description, not a name: "the man behind the desk",
 * "my son", "that woman", "the quest". A determiner followed by a proper noun is still a
 * name-form ("the Adventure Society", "the Queen", "The Sanguine Horror") and is kept.
 */
export function isDescriptiveAlias(alias: string): boolean {
  const tokens = alias.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  if (!DETERMINERS.has((tokens[0] as string).toLowerCase())) return false;
  return !tokens.slice(1).some((t) => /^[\p{Lu}#\d[]/u.test(t));
}

/** A dropped-by-cleaning alias: bare noise, a possessive of the entity's own name, or (names-only) a description. */
export function isDroppableAlias(alias: string, entity: RegistryEntity, policy: AliasPolicy = "default"): boolean {
  if (isNoiseAlias(alias) || isPossessiveOfName(alias, nameFormsOf(entity))) return true;
  return policy === "names-only" && isDescriptiveAlias(alias);
}
