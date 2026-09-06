/**
 * Builds the galaxy graph from a set of notes.
 *
 * Two notes are linked when one wikilinks the other, or when one's prose
 * mentions the other's title. Matching runs on the normalised form of both
 * sides, so casing, punctuation and separator style do not affect it.
 */

import type {
  BuildOptions,
  Galaxy,
  GalaxyLink,
  GalaxyNode,
  LinkKind,
  NoteSource,
} from './types.js';
import { extractWikilinkTargets, makeExcerpt, normalise, toPlainText } from './text.js';

const DEFAULT_EXCERPT_LENGTH = 700;
const DEFAULT_MIN_MENTION_LENGTH = 4;

/** Links are keyed by their ordered endpoints so an edge is stored once. */
function linkKey(a: number, b: number): string {
  return `${a}:${b}`;
}

/**
 * Records an edge, keeping the stronger reason when the same pair is found
 * twice: a wikilink is something the author wrote deliberately, a mention is
 * something we inferred, so a wikilink always wins.
 */
function addLink(
  links: Map<string, GalaxyLink>,
  a: number,
  b: number,
  kind: LinkKind,
): void {
  if (a === b) return;

  const source = Math.min(a, b);
  const target = Math.max(a, b);
  const key = linkKey(source, target);

  const existing = links.get(key);
  if (existing !== undefined && existing.kind === 'wikilink') return;

  links.set(key, { source, target, kind });
}

/**
 * Builds the graph.
 *
 * Mention detection walks each note's prose once against a title index, so the
 * cost follows the vault's total words rather than the square of its note
 * count. A vault of a few thousand notes builds in well under a second.
 */
export function buildGalaxy(notes: readonly NoteSource[], options: BuildOptions = {}): Galaxy {
  const excerptLength = options.excerptLength ?? DEFAULT_EXCERPT_LENGTH;
  const minMentionLength = options.minMentionLength ?? DEFAULT_MIN_MENTION_LENGTH;

  const nodes: GalaxyNode[] = notes.map((note, index) => ({
    id: index,
    key: note.key,
    label: note.label,
    group: note.group,
    excerpt: makeExcerpt(note.text, excerptLength),
  }));

  // Several notes may normalise to the same title; an ambiguous wikilink
  // resolves to all of them rather than silently picking one.
  const byTitle = new Map<string, number[]>();
  for (const node of nodes) {
    const title = normalise(node.label);
    if (title === '') continue;

    const bucket = byTitle.get(title);
    if (bucket === undefined) byTitle.set(title, [node.id]);
    else bucket.push(node.id);
  }

  const links = new Map<string, GalaxyLink>();

  notes.forEach((note, index) => {
    for (const target of extractWikilinkTargets(note.text)) {
      for (const id of byTitle.get(target) ?? []) addLink(links, index, id, 'wikilink');
    }
  });

  const prose: string[][] = notes.map((note) =>
    normalise(toPlainText(note.text))
      .split(' ')
      .filter((word) => word !== ''),
  );

  // Titles indexed by their opening word. Each note's prose is then walked once
  // and only the titles that could start at each position are compared, rather
  // than every title being searched for in every note.
  const candidates = new Map<string, { id: number; words: string[] }[]>();
  for (const node of nodes) {
    const title = normalise(node.label);
    if (title.length < minMentionLength) continue;

    const words = title.split(' ').filter((word) => word !== '');
    const first = words[0];
    if (first === undefined) continue;

    const bucket = candidates.get(first);
    if (bucket === undefined) candidates.set(first, [{ id: node.id, words }]);
    else bucket.push({ id: node.id, words });
  }

  for (let index = 0; index < prose.length; index += 1) {
    const words = prose[index] ?? [];

    for (let at = 0; at < words.length; at += 1) {
      const head = words[at];
      if (head === undefined) continue;

      for (const candidate of candidates.get(head) ?? []) {
        if (candidate.id === index) continue;
        if (at + candidate.words.length > words.length) continue;

        let matched = true;
        for (let offset = 1; offset < candidate.words.length; offset += 1) {
          if (words[at + offset] !== candidate.words[offset]) {
            matched = false;
            break;
          }
        }

        if (matched) addLink(links, index, candidate.id, 'mention');
      }
    }
  }

  const ordered = [...links.values()].sort(
    (left, right) => left.source - right.source || left.target - right.target,
  );

  return { nodes, links: ordered };
}

/**
 * Asserts the invariant the viewer relies on: a node's `id` is its position in
 * `nodes`, and every link points at a real node. Cheap enough to run on every
 * build, and it turns a class of silent lookup bugs into an immediate failure.
 */
export function assertGalaxyIntegrity(galaxy: Galaxy): void {
  galaxy.nodes.forEach((node, index) => {
    if (node.id !== index) {
      throw new Error(`Galaxy node at index ${index} has id ${node.id}; ids must equal the index.`);
    }
  });

  const count = galaxy.nodes.length;
  for (const link of galaxy.links) {
    if (link.source < 0 || link.source >= count || link.target < 0 || link.target >= count) {
      throw new Error(`Galaxy link ${link.source}->${link.target} refers to a node outside 0..${count - 1}.`);
    }
  }
}

/**
 * Adds a note to an existing set and rebuilds the graph.
 *
 * Safe precisely because ids are positions: appending leaves every existing
 * note at the index it already had and gives the new note the next one. A live
 * view can therefore draw the new node without re-resolving the ids it holds.
 * Inserting or removing anywhere else would renumber, and must not be done
 * while a view is open.
 */
export function appendNote(
  notes: readonly NoteSource[],
  note: NoteSource,
  options: BuildOptions = {},
): Galaxy {
  return buildGalaxy([...notes, note], options);
}
