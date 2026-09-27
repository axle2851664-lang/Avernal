/**
 * What a sentence asks Helix to keep.
 *
 * Two things are caught here and nothing else:
 *
 *   "Remember this: …"   an outright instruction, kept as long-term memory
 *   "I prefer …"         a preference stated in so many words
 *
 * The narrowness is the design. An assistant that decides for itself what
 * kind of person you are is one nobody can predict, so this matches phrases
 * rather than inferring intent — it reads what you said, it does not work out
 * what you meant. Everything it catches is reported back, so nothing is kept
 * quietly, and everything it keeps can be listed, edited and deleted like any
 * other memory.
 *
 * Pure: it takes a sentence and returns what it found. Storing is the store's
 * job, and the admission rules still apply on the way in — a "remember this"
 * carrying a password is still refused.
 */

import type { MemoryCategory, MemoryOrigin } from './types.js';

export interface Capture {
  readonly category: MemoryCategory;
  readonly text: string;
  readonly reason: string;
  readonly origin: MemoryOrigin;
  /** The phrase that matched, so the user can be told why this was kept. */
  readonly trigger: string;
}

/** Nothing shorter is a memory; it is a fragment of one. */
const MIN_LENGTH = 3;

interface Rule {
  readonly pattern: RegExp;
  readonly category: MemoryCategory;
  readonly origin: MemoryOrigin;
  readonly reason: string;
  readonly trigger: string;
  /** True when the matched text should be kept as the whole sentence. */
  readonly whole?: boolean;
}

/*
 * Outright instructions. The capture group is what to keep.
 *
 * Each is anchored at the start: "remember this" in the middle of a sentence
 * is usually somebody talking about remembering, not asking for it.
 */
const INSTRUCTIONS: readonly Rule[] = [
  {
    pattern: /^\s*(?:please\s+)?remember\s+(?:this|that)\s*[:,-]?\s*(.+)$/i,
    category: 'long-term',
    origin: 'user-command',
    reason: 'Asked to remember it',
    trigger: 'remember this',
  },
  {
    pattern: /^\s*(?:please\s+)?remember\s*[:,-]\s*(.+)$/i,
    category: 'long-term',
    origin: 'user-command',
    reason: 'Asked to remember it',
    trigger: 'remember',
  },
  {
    pattern: /^\s*(?:please\s+)?(?:do\s*n[o']t|don't|never)\s+forget\s+(?:that\s+)?(.+)$/i,
    category: 'long-term',
    origin: 'user-command',
    reason: 'Asked not to forget it',
    trigger: "don't forget",
  },
  {
    pattern: /^\s*(?:please\s+)?keep\s+in\s+mind\s+(?:that\s+)?(.+)$/i,
    category: 'long-term',
    origin: 'user-command',
    reason: 'Asked to keep it in mind',
    trigger: 'keep in mind',
  },
  {
    pattern: /^\s*(?:please\s+)?make\s+a\s+note\s+(?:that|of)\s+(.+)$/i,
    category: 'long-term',
    origin: 'user-command',
    reason: 'Asked to note it',
    trigger: 'make a note',
  },
];

/*
 * Stated preferences.
 *
 * These keep the whole sentence rather than a capture group: "I prefer short
 * answers" is the memory, where "short answers" on its own is not. Each has
 * to be the shape of a standing instruction — a one-off "don't do that" is
 * deliberately not here, because it is about this moment, not about you.
 */
const PREFERENCES: readonly Rule[] = [
  {
    pattern: /^\s*i\s+(?:really\s+)?(?:prefer|like|love|hate|dislike|can'?t\s+stand)\s+.+$/i,
    category: 'preference',
    origin: 'stated',
    reason: 'Stated as a preference',
    trigger: 'I prefer / I like / I hate',
    whole: true,
  },
  {
    pattern: /^\s*i\s+(?:do\s*n[o']t|don't)\s+(?:like|want)\s+.+$/i,
    category: 'preference',
    origin: 'stated',
    reason: 'Stated as a preference',
    trigger: "I don't like",
    whole: true,
  },
  {
    pattern: /^\s*from\s+now\s+on\s*[,:]?\s*.+$/i,
    category: 'preference',
    origin: 'stated',
    reason: 'Stated as a standing instruction',
    trigger: 'from now on',
    whole: true,
  },
  {
    pattern: /^\s*(?:always|never)\s+.+$/i,
    category: 'preference',
    origin: 'stated',
    reason: 'Stated as a standing instruction',
    trigger: 'always / never',
    whole: true,
  },
  {
    pattern: /^\s*call\s+me\s+.+$/i,
    category: 'preference',
    origin: 'stated',
    reason: 'Stated how to be addressed',
    trigger: 'call me',
    whole: true,
  },
  {
    pattern: /^\s*(?:stop|quit)\s+\w+ing\s+.+$/i,
    category: 'preference',
    origin: 'stated',
    reason: 'Asked to stop doing it',
    trigger: 'stop …ing',
    whole: true,
  },
];

/**
 * A question is never a capture.
 *
 * "Do I prefer tea?" and "What should I always do?" both match a preference
 * shape and neither states one. This is the single cheapest guard against the
 * failure that matters — keeping something the user never said.
 */
function isQuestion(utterance: string): boolean {
  if (utterance.trim().endsWith('?')) return true;
  if (/^\s*(?:what|who|when|where|why|how|which)\b/i.test(utterance)) return true;

  // A leading auxiliary usually opens a question — but not when it is
  // negated, because "Do not forget the lease" is an order, not an enquiry.
  return /^\s*(?:do|does|did|is|are|was|were|can|could|should|would|will|have|has)\s+(?!not\b|n[o']t\b)/i.test(
    utterance
  );
}

function tidy(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    // Whatever separator was used between the instruction and the thing.
    // Listing every dash in every pattern is how one gets missed.
    .replace(/^[\s:,\-\u2010-\u2015]+/, '')
    .replace(/[.,;:]+$/, '')
    .trim();
}

/**
 * What this sentence asks to be kept.
 *
 * At most one instruction and one preference: a single sentence saying two
 * things is possible, a single sentence saying five is a misfire.
 */
export function capturesFrom(utterance: string): readonly Capture[] {
  if (isQuestion(utterance)) return [];

  const found: Capture[] = [];

  for (const rule of INSTRUCTIONS) {
    const match = rule.pattern.exec(utterance);
    if (match === null) continue;
    const text = tidy(match[1] ?? '');
    if (text.length < MIN_LENGTH) break;
    found.push({
      category: rule.category,
      text,
      reason: rule.reason,
      origin: rule.origin,
      trigger: rule.trigger,
    });
    break;
  }

  for (const rule of PREFERENCES) {
    if (!rule.pattern.test(utterance)) continue;
    const text = tidy(utterance);
    if (text.length < MIN_LENGTH) break;
    // An outright instruction already covers the sentence; a preference read
    // of the same words would store it twice.
    if (found.length > 0) break;
    found.push({
      category: rule.category,
      text,
      reason: rule.reason,
      origin: rule.origin,
      trigger: rule.trigger,
    });
    break;
  }

  return found;
}
