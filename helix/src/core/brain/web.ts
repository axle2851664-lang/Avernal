/**
 * When Helix should be handed the web.
 *
 * Two ways in, and both are the user's:
 *
 *   1. They say so — "search the web", "look it up", "google it".
 *   2. They ask something the vault cannot answer by its nature: what is
 *      happening now, what something costs today, what the latest version is.
 *
 * The second is the interesting one, and it is deliberately a phrase match
 * rather than a judgement. A model deciding for itself whether a question is
 * "current" would reach for the web on half of them, and every one of those
 * is a billed search and a reply built on a page instead of on the notes the
 * vault exists to hold. Matching stated intent keeps the default — answer
 * from what you have — and makes the exception something the user asked for
 * in words they can see.
 *
 * This only decides whether the tool is *offered*. Helix still chooses
 * whether to call it, and a question he can answer from a note does not cost
 * a search just because the word "latest" was in it.
 */

/** Why the web was turned on, in the words that did it. */
export interface WebTrigger {
  /** The phrase that matched, for the reply to name. */
  readonly phrase: string;
  /** Whether the user asked outright, or the subject implies it. */
  readonly kind: 'asked' | 'current';
}

/**
 * Said outright. These are instructions, so they win over everything and
 * carry no risk of a false positive worth worrying about.
 */
const ASKED: readonly { readonly pattern: RegExp; readonly phrase: string }[] = [
  { pattern: /\b(search|look)\s+(?:it\s+|that\s+|this\s+)?(?:up\s+)?(?:on\s+)?(?:the\s+)?(?:web|internet|online)\b/i, phrase: 'search the web' },
  { pattern: /\b(?:search|google|bing|duckduckgo)\s+(?:for\s+)?\S/i, phrase: 'search' },
  { pattern: /\blook\s+(?:it|that|this)\s+up\b/i, phrase: 'look it up' },
  { pattern: /\b(?:web|internet|online)\s+search\b/i, phrase: 'web search' },
  { pattern: /\bcheck\s+(?:the\s+)?(?:web|internet|online)\b/i, phrase: 'check the web' },
  { pattern: /\bon\s+the\s+(?:web|internet)\b/i, phrase: 'on the web' },
];

/**
 * Implied by the subject. Narrower, and every one of them describes
 * information that cannot be in a personal vault by definition.
 */
const CURRENT: readonly { readonly pattern: RegExp; readonly phrase: string }[] = [
  { pattern: /\bwhat(?:'s| is| are)\s+(?:the\s+)?(?:latest|newest|current)\b/i, phrase: 'the latest' },
  { pattern: /\b(?:latest|current)\s+(?:news|version|release|price|score|weather|headlines)\b/i, phrase: 'latest news' },
  { pattern: /\bright\s+now\b/i, phrase: 'right now' },
  { pattern: /\bin\s+the\s+news\b/i, phrase: 'in the news' },
  { pattern: /\bwho\s+won\b/i, phrase: 'who won' },
  { pattern: /\bhow\s+much\s+(?:does|do|is)\b.*\b(?:cost|costs)\b/i, phrase: 'how much does it cost' },
  { pattern: /\b(?:stock|share)\s+price\b/i, phrase: 'stock price' },
  { pattern: /\bweather\b/i, phrase: 'weather' },
  { pattern: /\btoday(?:'s)?\b/i, phrase: 'today' },
  { pattern: /\bthis\s+(?:week|morning|evening|afternoon)\b/i, phrase: 'this week' },
];

/**
 * Turn it off explicitly.
 *
 * Without this there is no way to ask about "the latest note I wrote today"
 * and stay off the web, and being unable to decline is not a setting.
 */
/*
 * The verbs take any ending. Written as bare words with a trailing \b, this
 * matched "without search" and not "without searching" — the boundary lands
 * mid-word and the whole alternation fails.
 */
const REFUSED =
  /\b(?:don'?t|do not|no need to|without)\s+(?:search\w*|look\w*\s+(?:it|that|this)\s+up|us\w+\s+the\s+web|go\w*\s+online)\b/i;

/**
 * Should this question be answered with the web available?
 *
 * Returns why, so the answer can say which words turned it on — a search the
 * user did not expect is worse than no search, and naming the trigger is what
 * makes it predictable rather than magic.
 */
export function webTriggerFor(utterance: string): WebTrigger | null {
  const said = utterance.trim();
  if (said === '') return null;
  if (REFUSED.test(said)) return null;

  for (const rule of ASKED) {
    if (rule.pattern.test(said)) return { phrase: rule.phrase, kind: 'asked' };
  }
  for (const rule of CURRENT) {
    if (rule.pattern.test(said)) return { phrase: rule.phrase, kind: 'current' };
  }
  return null;
}

/**
 * What to add to the system prompt when the web is on.
 *
 * The persona forbids using anything but the notes, which is the rule that
 * keeps Helix from inventing facts. A search result is neither a note nor
 * invention, so the exception has to be stated — and stated narrowly, or the
 * "nothing from your own knowledge" rule quietly stops applying on every turn
 * where a search was offered and not used.
 */
export const WEB_ADDENDUM = `
THE WEB, THIS TURN ONLY
You have a web search tool available for this question and no other.

Use it when the answer is not in the notes and is the kind of thing the web
knows: what is happening now, what something costs, what was released. Do not
use it to check something the notes already answer.

What comes back from a search is a fact you may use, exactly like a note. Your
own recollection is still not: if the search does not cover it and the notes do
not either, say so.

Say where it came from in the same breath — "the web says", "according to what
I found" — so it is never unclear which half is the vault and which half is a
page you just read. One sentence still. Two at the outside.`;
