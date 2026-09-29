/**
 * Recognising that someone is talking about their notes.
 *
 * One module, so the microphone and the keyboard reach it by the same road:
 * whatever is said or typed goes through `notepadIntent`, and the caller acts
 * on the answer. A second implementation for voice would drift from this one
 * within a week.
 *
 * Deliberately phrase matching rather than asking a model. It costs nothing,
 * it runs with no key configured, it is the same every time, and — the part
 * that matters — a wrong guess here would delete a note. A rule you can read
 * is worth more than a judgement you cannot.
 *
 * Order is significant. "delete my note about X" is a delete, not a search,
 * even though it contains "note about"; the destructive readings are tested
 * first so a near-miss falls through to something harmless.
 */

/** What the person wants doing with their notes. */
export type NotepadAction =
  | 'open'
  | 'create'
  | 'search'
  | 'delete'
  | 'export';

export interface NotepadIntent {
  readonly action: NotepadAction;
  /** The note text, the search term, or the note named — empty when none. */
  readonly subject: string;
  /** The words that decided it, so a reply can say why. */
  readonly phrase: string;
}

interface Rule {
  readonly pattern: RegExp;
  readonly action: NotepadAction;
  readonly phrase: string;
  /** Which capture group holds the subject. Omitted when there is none. */
  readonly subject?: number;
}

/*
 * "notepad", "note pad", "notebook", "notes", "my notes" — and the same words
 * with Helix's name in front, which is how people actually talk to him.
 */
const PAD = '(?:note ?pad|note ?book|notes)';

const RULES: readonly Rule[] = [
  /* ---------------------------------------------------------- destructive */
  {
    pattern: new RegExp('\\b(?:delete|remove|forget|bin|trash)\\b.{0,20}\\bnote\\b(?:\\s+(?:about|on|called|named|titled)\\s+(.+))?', 'i'),
    action: 'delete',
    phrase: 'delete note',
    subject: 1,
  },
  {
    pattern: new RegExp('\\b(?:delete|remove|clear)\\s+(?:my\\s+|the\\s+)?' + PAD + '\\b', 'i'),
    action: 'delete',
    phrase: 'delete notes',
  },

  /* -------------------------------------------------------------- export */
  {
    pattern: new RegExp('\\b(?:export|back ?up|save a copy of|copy)\\b.{0,20}\\b(?:' + PAD + '|note)\\b', 'i'),
    action: 'export',
    phrase: 'export notes',
  },

  /* -------------------------------------------------------------- search */
  {
    pattern: new RegExp('\\b(?:find|search(?:\\s+(?:for|in|through))?|look\\s+(?:for|up)|which|what)\\b.{0,30}\\bnotes?\\b\\s*(?:about|on|for|mentioning|regarding|to do with)\\s+(.+)', 'i'),
    action: 'search',
    phrase: 'find a note about',
    subject: 1,
  },
  {
    pattern: new RegExp('\\b(?:search|look\\s+through|go\\s+through)\\s+(?:my\\s+|the\\s+)?' + PAD + '\\s+(?:for|about)\\s+(.+)', 'i'),
    action: 'search',
    phrase: 'search my notes for',
    subject: 1,
  },
  {
    pattern: new RegExp('\\bwhat\\s+did\\s+i\\s+(?:write|note|say|put)\\b.{0,20}?(?:about|on|regarding)\\s+(.+)', 'i'),
    action: 'search',
    phrase: 'what did I write about',
    subject: 1,
  },

  /* -------------------------------------------------------------- create */
  {
    pattern: new RegExp('\\b(?:create|make|start|add|write|save|store|put|jot|new)\\b[^.]{0,20}?\\bnote\\b\\s*(?:called|named|titled|saying|that says)?\\s*(.*)', 'i'),
    action: 'create',
    phrase: 'create a note',
    subject: 1,
  },
  {
    pattern: new RegExp('\\b(?:add|save|put|store)\\s+(?:this|that|it)\\s+(?:to|in|into)\\s+(?:my\\s+|the\\s+)?' + PAD + '\\b\\s*(.*)', 'i'),
    action: 'create',
    phrase: 'add this to my notes',
    subject: 1,
  },

  /* ---------------------------------------------------------------- open */
  {
    pattern: new RegExp('\\b(?:open|show|list|read|bring up|go to|pull up|display)\\b.{0,15}\\b(?:my\\s+)?' + PAD + '\\b', 'i'),
    action: 'open',
    phrase: 'open my notes',
  },
  {
    pattern: new RegExp('^\\s*(?:helix[,\\s]+)?(?:my\\s+)?' + PAD + '\\s*[.!?]?\\s*$', 'i'),
    action: 'open',
    phrase: 'notepad',
  },
];

/**
 * What, if anything, this is asking for.
 *
 * Returns null for anything that is not about notes, which is most of what
 * anyone says — the caller carries on to the ordinary answer path.
 */
export function notepadIntent(utterance: string): NotepadIntent | null {
  const said = utterance.trim();
  if (said === '') return null;

  for (const rule of RULES) {
    const match = rule.pattern.exec(said);
    if (match === null) continue;

    const raw = rule.subject === undefined ? '' : (match[rule.subject] ?? '');
    return { action: rule.action, subject: tidy(raw), phrase: rule.phrase };
  }
  return null;
}

/**
 * Trim the scaffolding off a captured subject.
 *
 * "find my note about the reselling business, please" should search for
 * "reselling business", not for the politeness.
 */
function tidy(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:the|a|an|my)\s+/i, '')
    .replace(/[,.!?;:]+$/, '')
    .replace(/\s+please$/i, '')
    .trim();
}
