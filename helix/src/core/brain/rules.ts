/**
 * What Helix is allowed to remember.
 *
 * The rule that shapes this file: Helix does not quietly keep everything it
 * sees. Anything meant to outlive the session has to have been asked for.
 * Observations are allowed to accumulate only in short-term memory, which is
 * discarded when the session ends.
 *
 * Every refusal comes back with a sentence the user can read, because a
 * silent refusal is as opaque as a silent save.
 */

import type { MemoryDraft } from './types.js';
import { findSecrets, refusalFor } from './secrets.js';

/** Long enough for a paragraph of context, short enough not to be a document. */
export const MAX_TEXT_LENGTH = 2000;
export const MAX_REASON_LENGTH = 300;

export type Admission =
  | { readonly admit: true; readonly reason: string }
  | { readonly admit: false; readonly refusal: string };

/**
 * Categories that outlive the session. Nothing lands here without the user
 * having asked: an assistant that decides on its own what is worth keeping
 * forever is one nobody can predict.
 */
const DURABLE = new Set(['long-term', 'preference', 'project', 'task']);

function blank(value: string): boolean {
  return value.trim() === '';
}

/**
 * Decide whether a draft may be stored.
 *
 * Pure, so the policy can be read and tested on its own rather than inferred
 * from the behaviour of the store.
 */
export function assess(draft: MemoryDraft): Admission {
  if (blank(draft.text)) {
    return { admit: false, refusal: 'Nothing to remember: the text is empty.' };
  }

  if (draft.text.length > MAX_TEXT_LENGTH) {
    return {
      admit: false,
      refusal:
        'That is too long to remember as one item (' +
        draft.text.length +
        ' characters, limit ' +
        MAX_TEXT_LENGTH +
        '). Save it as a note in the vault and remember a pointer to it instead.',
    };
  }

  if (blank(draft.reason)) {
    return {
      admit: false,
      refusal: 'Refusing to remember this without a reason. Every memory has to say why it was kept.',
    };
  }

  if (draft.reason.length > MAX_REASON_LENGTH) {
    return { admit: false, refusal: 'The reason is too long to be a reason.' };
  }

  // Credentials are checked on both fields. A reason is stored and shown just
  // as the text is, so it is no safer a place to put a password.
  const secrets = findSecrets(draft.text + '\n' + draft.reason);
  if (secrets.length > 0) {
    return { admit: false, refusal: refusalFor(secrets) };
  }

  if (DURABLE.has(draft.category) && draft.source.origin === 'observation') {
    return {
      admit: false,
      refusal:
        'Refusing to keep an observation in ' +
        draft.category +
        ' memory. Anything that outlives this session has to be asked for; ' +
        'noticed things go to short-term memory.',
    };
  }

  if (draft.category === 'project' && (draft.projectId ?? '') === '') {
    return { admit: false, refusal: 'Project memory has to name the project it belongs to.' };
  }

  if (draft.category === 'short-term' && (draft.sessionId ?? '') === '') {
    return {
      admit: false,
      refusal: 'Short-term memory has to name its session, or there is no knowing when to drop it.',
    };
  }

  return { admit: true, reason: draft.reason.trim() };
}

/**
 * Whether two pieces of text are the same memory said twice.
 *
 * Compared loosely — case, punctuation and spacing removed — so re-running the
 * same instruction does not leave two copies. Not a similarity measure: near
 * misses are two memories, and the user can merge them if they disagree.
 */
export function sameMemory(left: string, right: string): boolean {
  const flatten = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return flatten(left) === flatten(right);
}
