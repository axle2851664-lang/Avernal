/**
 * Ranks notes against a question by keyword overlap.
 *
 * This is the selection half of answering: it decides which notes become
 * context. Assembling the prompt and speaking the answer belong to the
 * orchestrator and the persona, not here.
 */

import type { Galaxy, ScoredNote } from './types.js';
import { normalise } from './text.js';

/** A title hit says more about relevance than a body hit, so it counts for more. */
const TITLE_WEIGHT = 3;
const BODY_WEIGHT = 1;
const GROUP_WEIGHT = 1;

/**
 * Ceiling on how much one repeated term can contribute. Without it a note that
 * happens to say "storage" forty times outranks the note actually about it.
 */
const BODY_OCCURRENCE_CAP = 3;

const MIN_TOKEN_LENGTH = 2;
const DEFAULT_LIMIT = 6;

const STOP_WORDS = new Set([
  'a', 'about', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'did', 'do', 'does', 'for', 'from', 'get', 'had', 'has', 'have', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'so', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

/** Meaningful search terms from a question, de-duplicated, order preserved. */
export function tokenise(question: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const token of normalise(question).split(' ')) {
    if (token.length < MIN_TOKEN_LENGTH || STOP_WORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }

  return tokens;
}

/**
 * Token to node to that token's score contribution for the node.
 *
 * Built once per galaxy so a question costs a handful of map lookups instead of
 * a scan of every note. The contribution is precomputed rather than the raw
 * counts, since the weighting never varies between questions.
 */
type SearchIndex = Map<string, Map<number, number>>;

/**
 * Cached against the galaxy object itself, so callers keep the simple
 * `selectNotes(galaxy, question)` shape and a rebuilt galaxy — after a capture,
 * say — naturally gets a fresh index.
 */
const indexes = new WeakMap<Galaxy, SearchIndex>();

function words(value: string): string[] {
  return normalise(value)
    .split(' ')
    .filter((word) => word !== '');
}

function contribute(index: SearchIndex, token: string, id: number, amount: number): void {
  let hits = index.get(token);
  if (hits === undefined) {
    hits = new Map<number, number>();
    index.set(token, hits);
  }

  hits.set(id, (hits.get(id) ?? 0) + amount);
}

function buildSearchIndex(galaxy: Galaxy): SearchIndex {
  const index: SearchIndex = new Map();

  for (const node of galaxy.nodes) {
    for (const token of new Set(words(node.label))) {
      contribute(index, token, node.id, TITLE_WEIGHT);
    }

    for (const token of new Set(words(node.group))) {
      contribute(index, token, node.id, GROUP_WEIGHT);
    }

    const counts = new Map<string, number>();
    for (const token of words(node.excerpt)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    for (const [token, count] of counts) {
      contribute(index, token, node.id, Math.min(count, BODY_OCCURRENCE_CAP) * BODY_WEIGHT);
    }
  }

  return index;
}

function searchIndexFor(galaxy: Galaxy): SearchIndex {
  let index = indexes.get(galaxy);
  if (index === undefined) {
    index = buildSearchIndex(galaxy);
    indexes.set(galaxy, index);
  }

  return index;
}

/**
 * The highest-scoring notes for a question, best first. Notes with no overlap
 * are left out entirely rather than padding the result with noise.
 *
 * Ties break towards the lower node id, so the same question always yields the
 * same context and answers stay reproducible.
 */
export function selectNotes(
  galaxy: Galaxy,
  question: string,
  limit: number = DEFAULT_LIMIT,
): ScoredNote[] {
  const tokens = tokenise(question);
  if (tokens.length === 0 || limit <= 0) return [];

  const index = searchIndexFor(galaxy);
  const totals = new Map<number, number>();

  for (const token of tokens) {
    const hits = index.get(token);
    if (hits === undefined) continue;

    for (const [id, contribution] of hits) {
      totals.set(id, (totals.get(id) ?? 0) + contribution);
    }
  }

  const scored: ScoredNote[] = [...totals]
    .filter(([, score]) => score > 0)
    .map(([id, score]) => ({ id, score }));

  scored.sort((left, right) => right.score - left.score || left.id - right.id);
  return scored.slice(0, limit);
}

/**
 * Builds the search index before the first question arrives.
 *
 * Optional — the index is built on demand either way — but calling this once the
 * galaxy is ready moves the cost off the first question, which is the one
 * somebody is actually waiting on.
 */
export function warmSearchIndex(galaxy: Galaxy): void {
  searchIndexFor(galaxy);
}

/**
 * The score a note must reach before it counts as having grounded an answer:
 * one title hit, or three mentions in the body.
 *
 * This is what separates "he asked about his notes" from "a word in his small
 * talk happened to appear somewhere". Below it, a note is a coincidence, and
 * lighting it up in the galaxy would claim a provenance that does not exist.
 */
export const GROUNDING_THRESHOLD = TITLE_WEIGHT;

/**
 * Notes strong enough to answer from, best first.
 *
 * Unlike `selectNotes` this can return nothing at all, which is the point: an
 * empty result is how small talk stays small talk, leaving the camera still and
 * the answer ungrounded rather than manufacturing a source.
 */
export function groundedNotes(
  galaxy: Galaxy,
  question: string,
  limit: number = DEFAULT_LIMIT,
): ScoredNote[] {
  return selectNotes(galaxy, question, limit).filter((note) => note.score >= GROUNDING_THRESHOLD);
}
