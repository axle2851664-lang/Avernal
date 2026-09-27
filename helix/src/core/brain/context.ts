/**
 * Decides what Helix already knows that bears on what was just said.
 *
 * This is the difference between "Continue the website project" being a new
 * sentence and being a reference to work already under way. It resolves the
 * project the sentence points at, then ranks memory against the words used.
 *
 * The ranking reuses the vault's tokeniser so a question is split the same way
 * everywhere in Helix, rather than by a second set of stop words that drifts
 * from the first.
 */

import { tokenise } from '../galaxy/retrieval.js';
import type { ContextItem, ContextResult, Memory, MemoryCategory, Project } from './types.js';
import type { MemoryStore } from './store.js';

const DEFAULT_LIMIT = 8;

/**
 * How much each kind of memory counts before the words are looked at.
 *
 * Preferences and open tasks are close to always relevant — how the user wants
 * to be spoken to applies to every request — where a stray short-term note
 * only matters if the words actually match.
 */
const CATEGORY_WEIGHT: Readonly<Record<MemoryCategory, number>> = {
  preference: 3,
  task: 2.5,
  project: 2,
  'long-term': 1.5,
  'short-term': 1,
};

/** A term appearing in the memory itself says more than one in its reason. */
const TEXT_WEIGHT = 2;
const REASON_WEIGHT = 0.5;
const TAG_WEIGHT = 1.5;

/** Being in the project under discussion is worth more than any single word. */
const PROJECT_BONUS = 4;

/** Words that mean "the thing we were doing", not a topic to search for. */
const CONTINUATION = /\b(?:continue|carry on|resume|pick up|back to|keep going|finish)\b/i;

function flatten(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Which project this sentence is about.
 *
 * Matched on the project's own name appearing in the sentence. When the
 * sentence is a continuation — "continue", "back to", "pick up" — and names no
 * project, the most recently touched one is the honest answer, because that is
 * what "continue" refers to.
 */
export function resolveProject(
  utterance: string,
  projects: readonly Project[],
  currentProjectId: string | null = null
): string | null {
  const said = flatten(utterance);

  // Longest name first, so "website redesign" wins over "website".
  const byLength = [...projects].sort((a, b) => flatten(b.name).length - flatten(a.name).length);
  for (const project of byLength) {
    const name = flatten(project.name);
    if (name !== '' && said.includes(name)) return project.id;
  }

  if (currentProjectId !== null) return currentProjectId;

  if (CONTINUATION.test(utterance) && projects.length > 0) {
    // projects() is ordered most recently touched first.
    return projects[0]?.id ?? null;
  }

  return null;
}

function scoreAgainstTerms(memory: Memory, terms: readonly string[]): { score: number; hits: string[] } {
  const text = flatten(memory.text);
  const reason = flatten(memory.reason);
  const tags = flatten(memory.tags.join(' '));

  let score = 0;
  const hits: string[] = [];

  for (const term of terms) {
    let termScore = 0;
    if (text.includes(term)) termScore += TEXT_WEIGHT;
    if (tags.includes(term)) termScore += TAG_WEIGHT;
    if (reason.includes(term)) termScore += REASON_WEIGHT;
    if (termScore > 0) {
      score += termScore;
      hits.push(term);
    }
  }

  return { score, hits };
}

function explain(memory: Memory, hits: readonly string[], inProject: boolean): string {
  const parts: string[] = [];
  if (inProject) parts.push('belongs to this project');
  if (hits.length > 0) parts.push('mentions ' + hits.join(', '));
  if (memory.category === 'preference') parts.push('is a standing preference');
  if (memory.category === 'task' && memory.taskState === 'open') parts.push('is an open task');
  return parts.length === 0 ? 'was in scope' : parts.join('; ');
}

export interface ContextOptions {
  readonly sessionId?: string;
  readonly currentProjectId?: string | null;
  readonly limit?: number;
}

/**
 * Assemble the context for one utterance.
 *
 * Returns what was chosen *and* why, because context that cannot be explained
 * cannot be debugged — when Helix answers using the wrong memory, this is
 * where you look.
 */
export function buildContext(
  store: MemoryStore,
  utterance: string,
  options: ContextOptions = {}
): ContextResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const projects = store.projects();
  const projectId = resolveProject(utterance, projects, options.currentProjectId ?? null);
  const terms = tokenise(utterance);

  const items: ContextItem[] = [];

  for (const memory of store.all()) {
    // Another session's short-term memory is not this session's context.
    if (
      memory.category === 'short-term' &&
      options.sessionId !== undefined &&
      memory.sessionId !== options.sessionId
    ) {
      continue;
    }

    // Finished and abandoned tasks are history, not current context.
    if (memory.category === 'task' && (memory.taskState === 'done' || memory.taskState === 'abandoned')) {
      continue;
    }

    const inProject = projectId !== null && memory.projectId === projectId;
    const { score: termScore, hits } = scoreAgainstTerms(memory, terms);

    let score = termScore;
    if (inProject) score += PROJECT_BONUS;

    // Preferences and open tasks stand without a word match; everything else
    // has to earn its place, or every request drags in the whole store.
    const standing = memory.category === 'preference' || memory.category === 'task';
    if (score === 0 && !standing) continue;

    score += CATEGORY_WEIGHT[memory.category];

    items.push({ memory, score, because: explain(memory, hits, inProject) });
  }

  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Ties go to whatever was touched most recently.
    return a.memory.updatedAt < b.memory.updatedAt ? 1 : -1;
  });

  return { utterance, projectId, items: items.slice(0, limit), terms };
}
