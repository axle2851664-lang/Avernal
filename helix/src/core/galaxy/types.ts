/**
 * Knowledge-galaxy data model.
 *
 * These types are deliberately free of any Helix dependency. `NoteSource` is
 * the seam: whatever supplies notes (KnowledgeIndex, a directory scan, a test
 * fixture) is adapted to this shape, and everything downstream is pure.
 */

/** A note as the galaxy needs to see it, independent of where it came from. */
export interface NoteSource {
  /** Stable identifier from the providing system. Used only for adapter-side lookups. */
  readonly key: string;
  /** Display label for the node, normally derived from the file name. */
  readonly label: string;
  /** Grouping used for colour coding — normally the containing folder. */
  readonly group: string;
  /** Raw note body, markdown included. */
  readonly text: string;
}

/**
 * A node in the galaxy.
 *
 * `id` is the node's index in the `nodes` array and nothing else. Features that
 * look nodes up by position depend on that, so it is asserted at build time
 * rather than left as a convention.
 */
export interface GalaxyNode {
  readonly id: number;
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly excerpt: string;
}

/** Why two notes are connected. A wikilink is an explicit link the author wrote. */
export type LinkKind = 'wikilink' | 'mention';

/** An undirected edge. `source` and `target` are node indices, always source < target. */
export interface GalaxyLink {
  readonly source: number;
  readonly target: number;
  readonly kind: LinkKind;
}

export interface Galaxy {
  readonly nodes: readonly GalaxyNode[];
  readonly links: readonly GalaxyLink[];
}

export interface BuildOptions {
  /** Excerpt length in characters, trimmed to a word boundary. */
  readonly excerptLength?: number;
  /**
   * Shortest label allowed to create a mention link. Short labels ("AI", "Log")
   * match far too much prose to be meaningful edges.
   */
  readonly minMentionLength?: number;
}

/** A note selected as context for an answer, with the score that selected it. */
export interface ScoredNote {
  /** Index into the galaxy's `nodes` array. */
  readonly id: number;
  readonly score: number;
}
