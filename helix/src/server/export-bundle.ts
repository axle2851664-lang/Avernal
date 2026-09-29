/**
 * Packing Helix's own data into something portable.
 *
 * What this is honest about, up front: a web page cannot see a USB stick, and
 * a server cannot see one plugged into the phone that is talking to it. So
 * there is no drive detection here and nothing pretends there is. What there
 * is, is a bundle — a documented, structured archive the browser downloads and
 * you put wherever you like, including on a flash drive.
 *
 * What never goes in it: API keys, OAuth tokens, cookies, the session secret.
 * Those live in .env and .tokens.json and neither is readable from here. The
 * bundle is built from named sources rather than by sweeping a directory,
 * which is what makes that true rather than merely intended.
 */

import type { Memory } from '../core/brain/types.js';
import type { Note } from '../platform/vault/notepad.js';

/** Which parts of Helix go in. */
export type BundlePart = 'notepad' | 'memory' | 'conversation';

export interface BundleChoice {
  readonly id: string;
  readonly label: string;
  readonly parts: readonly BundlePart[];
  /** Said plainly on the screen before anything is written. */
  readonly contains: readonly string[];
}

/**
 * The offered combinations.
 *
 * Each one names what it holds, in words, because "export everything" is a
 * phrase people agree to without knowing what it covers.
 */
export const BUNDLE_CHOICES: readonly BundleChoice[] = [
  {
    id: 'notepad',
    label: 'Notepad only',
    parts: ['notepad'],
    contains: ['Every note, in full', 'Titles, tags, categories and dates'],
  },
  {
    id: 'memory',
    label: 'Memory only',
    parts: ['memory'],
    contains: ['What Helix has been told to remember', 'Why each thing was kept'],
  },
  {
    id: 'notepad-memory',
    label: 'Notepad and memory',
    parts: ['notepad', 'memory'],
    contains: ['Every note, in full', 'What Helix has been told to remember'],
  },
  {
    id: 'everything',
    label: 'Everything Helix knows',
    parts: ['notepad', 'memory', 'conversation'],
    contains: [
      'Every note, in full',
      'What Helix has been told to remember',
      'What you and Helix have said to each other',
    ],
  },
];

/**
 * What is never in any of them.
 *
 * Shown on the screen beside what is, because the reassuring half of an
 * export is the half that says what it left behind.
 */
export const NEVER_INCLUDED: readonly string[] = [
  'API keys and client secrets',
  'Google sign-in tokens',
  'Your Helix access token',
  'Anything outside the vault — no device files',
];

export interface BundleSources {
  readonly notes: readonly Note[];
  readonly memories: readonly Memory[];
  readonly turns: readonly { question: string; answer: string; at: string }[];
}

/** One file in the bundle: a path and its bytes. */
export interface BundleFile {
  readonly path: string;
  readonly body: string;
}

export interface Bundle {
  readonly choice: BundleChoice;
  readonly files: readonly BundleFile[];
  /** A count per part, so the screen can say what actually went in. */
  readonly counts: Record<string, number>;
}

export class BundleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

/** The format version, so a future import knows what it is reading. */
const FORMAT = 1;

export function choiceFor(id: unknown): BundleChoice {
  const found = BUNDLE_CHOICES.find((choice) => choice.id === id);
  if (found === undefined) {
    throw new BundleError('Helix does not export that combination.');
  }
  return found;
}

/**
 * Build the bundle.
 *
 * Pure: it is handed the data and returns files. Nothing here reads a disk or
 * a key, which is the structural reason a secret cannot end up in the output.
 */
export function buildBundle(choice: BundleChoice, sources: BundleSources, at: Date): Bundle {
  const files: BundleFile[] = [];
  const counts: Record<string, number> = {};
  const stamp = at.toISOString();

  if (choice.parts.includes('notepad')) {
    counts.notes = sources.notes.length;
    files.push({
      path: 'Helix/Notepad/notes.json',
      body: JSON.stringify(
        {
          format: FORMAT,
          kind: 'helix-notepad',
          exported: stamp,
          count: sources.notes.length,
          notes: sources.notes.map((note) => ({
            id: note.id,
            title: note.title,
            category: note.category,
            tags: note.tags,
            created: note.created,
            updated: note.updated,
            content: note.content,
          })),
        },
        null,
        2
      ),
    });
    // The same notes as prose. The JSON is for Helix; this is for a person
    // opening the drive on a machine that has never heard of Helix.
    files.push({
      path: 'Helix/Notepad/notes.txt',
      body:
        sources.notes
          .map((note) =>
            [
              note.title,
              '='.repeat(Math.min(72, Math.max(3, note.title.length))),
              'Created ' + note.created + (note.tags.length > 0 ? '   Tags: ' + note.tags.join(', ') : ''),
              '',
              note.content,
            ].join('\n')
          )
          .join('\n\n\n') + '\n',
    });
  }

  if (choice.parts.includes('memory')) {
    counts.memories = sources.memories.length;
    files.push({
      path: 'Helix/Memory/memory.json',
      body: JSON.stringify(
        {
          format: FORMAT,
          kind: 'helix-memory',
          exported: stamp,
          count: sources.memories.length,
          memories: sources.memories,
        },
        null,
        2
      ),
    });
  }

  if (choice.parts.includes('conversation')) {
    counts.turns = sources.turns.length;
    files.push({
      path: 'Helix/Conversation/conversation.json',
      body: JSON.stringify(
        {
          format: FORMAT,
          kind: 'helix-conversation',
          exported: stamp,
          count: sources.turns.length,
          turns: sources.turns,
        },
        null,
        2
      ),
    });
  }

  files.push({ path: 'Helix/README.txt', body: readme(choice, counts, stamp) });
  return { choice, files, counts };
}

function readme(choice: BundleChoice, counts: Record<string, number>, stamp: string): string {
  return [
    'HELIX EXPORT',
    '',
    'Made ' + stamp,
    'Contents: ' + choice.label,
    'Format version: ' + FORMAT,
    '',
    'WHAT IS IN HERE',
    ...choice.contains.map((line) => '  - ' + line),
    '',
    ...Object.entries(counts).map(([what, many]) => '  ' + many + ' ' + what),
    '',
    'WHAT IS NOT',
    ...NEVER_INCLUDED.map((line) => '  - ' + line),
    '',
    'Nothing in this folder is a credential. It is your own words and the',
    'notes you wrote. Treat it as you would a diary rather than a password',
    'file — private, but not dangerous if seen.',
    '',
    'PUTTING IT BACK',
    '',
    'The JSON files carry everything needed to restore them: each note keeps',
    'its id, title, tags and both dates, so a note restored is the note that',
    'left. Helix has no import screen yet — this bundle is the format it will',
    'read when it does, and until then notes.json is plain JSON that any tool',
    'can open.',
    '',
    'LAYOUT',
    '',
    '  Helix/',
    '    Notepad/notes.json    every note, with metadata',
    '    Notepad/notes.txt     the same notes, readable anywhere',
    '    Memory/memory.json    what Helix was told to remember',
    '    Conversation/…        what was said, if you chose to include it',
    '    README.txt            this file',
    '',
  ].join('\n');
}
