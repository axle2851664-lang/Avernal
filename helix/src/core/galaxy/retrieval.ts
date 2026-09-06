/**
 * Ranks notes against a question by keyword overlap.
 *
 * This is the selection half of answering: it decides which notes become
 * context. Assembling the prompt and speaking the answer belong to the
 * orchestrator and the persona, not here.
 */

import type { Galaxy, ScoredNote } from './types.js';
import { normalise, pad } from './text.js';

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

/** Whole-word occurrences of `token` in already-padded, normalised `haystack`. */
function countOccurrences(haystack: string, token: string): number {
  const needle = ` ${token} `;
  let count = 0;
  let from = 0;

  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    // Advance by one: adjacent matches share the space between them.
    from = at + 1;
  }
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

  const scored: ScoredNote[] = [];

  for (const node of galaxy.nodes) {
    const title = pad(node.label);
    const group = pad(node.group);
    const body = pad(node.excerpt);

    let score = 0;
    for (const token of tokens) {
      if (title.includes(` ${token} `)) score += TITLE_WEIGHT;
      if (group.includes(` ${token} `)) score += GROUP_WEIGHT;
      score += Math.min(countOccurrences(body, token), BODY_OCCURRENCE_CAP) * BODY_WEIGHT;
    }

    if (score > 0) scored.push({ id: node.id, score });
  }

  scored.sort((left, right) => right.score - left.score || left.id - right.id);
  return scored.slice(0, limit);
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
