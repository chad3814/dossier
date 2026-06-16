/** Classification of a spine entry, derived from its manifest idref. */
export type EntryType =
  | "chapter"
  | "part"
  | "prologue"
  | "interlude"
  | "epilogue"
  | "epigraph"
  | "front"
  | "other";

/** One entry in the EPUB spine (reading order). */
export interface SpineEntry {
  idref: string;
  href: string;
}

/**
 * A readable section of a book after parsing.
 * `label` is the citation token used in anchors, e.g. "C6", "Prologue".
 */
export interface Section {
  type: EntryType;
  label: string;
  chapterNumber: number | null;
  title: string;
  href: string;
  /** Every non-empty <p> in document order; index 0 == paragraph 1. */
  paragraphs: string[];
}

/** A group of consecutive sections sized for a single extraction agent. */
export interface Chunk {
  index: number;
  sections: Section[];
  wordCount: number;
}

/** A single resolved mention location. */
export interface Appearance {
  anchor: string;
  snippet: string;
}

export type Significance = "major" | "supporting" | "minor" | "mentioned";

export type EntityType =
  | "person"
  | "creature"
  | "faction"
  | "ai_system"
  | "place"
  | "other";

/** Classification tags applied orthogonally to `type`, used for filtering. */
export type EntityTag = "in_world" | "real_world_ref" | "media_ref" | "item_object";

/** One accumulating canonical entity in the cross-book registry (source of truth). */
export interface RegistryEntity {
  id: string;
  canonicalName: string;
  aliases: string[];
  type: EntityType;
  tags: EntityTag[];
  significance: Significance;
  description: string;
  firstAppearance: Appearance | null;
  /** Every B·C·¶ anchor across all processed books, in discovery order. */
  appearances: string[];
}

/** The cross-book registry accumulated as books are processed in order. */
export interface Registry {
  /** Books fully folded in, in order. */
  booksProcessed: number[];
  entities: RegistryEntity[];
}

/** Compact entry handed to chapter agents so they can match against known entities. */
export interface RegistryIndexEntry {
  id: string;
  canonicalName: string;
  aliases: string[];
  type: EntityType;
}

/**
 * The output of one book's extraction workflow: newly-introduced entities (fully
 * formed) plus matched anchors/aliases for already-known entities. Folded into the
 * cross-book registry by applyDelta(). Keeps prior appearances/descriptions out of
 * the workflow (which only carries the compact matching index).
 */
export interface RegistryDelta {
  booksProcessed: number[];
  matched: Array<{ id: string; anchor: string; aliases: string[] }>;
  newEntities: RegistryEntity[];
}

/** A chapter agent's report: mentions matched to known entities, plus newly found ones. */
export interface ChapterFindings {
  /** `aliases` carries any new name-forms (esp. Crawler #IDs) seen for the matched entity. */
  matched: Array<{ id: string; anchor: string; snippet: string; aliases?: string[] }>;
  new: Array<{
    name: string;
    aliases: string[];
    type: EntityType;
    tag: EntityTag;
    mentions: Appearance[];
  }>;
}

/** Per-book manifest emitted alongside the chunk files. */
export interface BookManifest {
  bookNumber: number;
  sourceEpub: string;
  sections: Array<{
    label: string;
    type: EntryType;
    title: string;
    paragraphCount: number;
    file: string;
  }>;
  sectionCount: number;
  totalWords: number;
}

/** A reading-position cutoff anchor, e.g. "B2·C4" (whole chapter) or "B2·C4·¶7". */
export type Cutoff = string;

/** Frozen id → canonical-id map capturing dedupe merges, applied at materialize time. */
export type MergeMap = Record<string, string>;

/** Frozen extra aliases (keyed by canonical id) added by post-passes beyond the delta log. */
export type AliasSupplement = Record<string, string[]>;
