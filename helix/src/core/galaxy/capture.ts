/**
 * Growing the vault by voice: turning "remember that ..." into a real note.
 *
 * Everything here is pure — deciding the title, the file name and the file's
 * contents. Writing the file and adding the node to the running galaxy belong
 * to the server and the view.
 */

import type { Galaxy } from './types.js';
import { normalise } from './text.js';
import { selectNotes } from './retrieval.js';

/** Captures live in their own folder so a spoken thought is never mistaken for a written note. */
export const CAPTURES_FOLDER = 'captures';

const TITLE_WORD_LIMIT = 8;
const TITLE_CHAR_LIMIT = 60;

/** "remember that ...", "remember ..." — with any trailing punctuation a transcript adds. */
const REMEMBER_PREFIX = /^\s*remember(?:\s+that)?\b[\s,:;.…-]*/i;

const TRAILING_PUNCTUATION = /[\s.,;:!?…-]+$/;

export interface CaptureDraft {
  /** Human-readable title, used as the note's label in the galaxy. */
  readonly title: string;
  /** File-name stem: lowercase, alphanumeric and hyphens only. */
  readonly slug: string;
  /** Path relative to the notes directory. */
  readonly relativePath: string;
  /** The remembered text, as spoken. */
  readonly content: string;
  /** Full file contents, front matter included. */
  readonly markdown: string;
}

export interface DraftOptions {
  readonly now?: Date;
  /** Slugs already in use, so a second capture cannot overwrite the first. */
  readonly taken?: ReadonlySet<string>;
}

/**
 * The text to remember, or null when this was not a capture.
 *
 * Both "remember that the ceiling is 40GB" and "remember the ceiling is 40GB"
 * count — speech transcripts drop small words, and losing a thought to a missing
 * "that" would be a poor way to learn the command.
 */
export function parseRememberCommand(input: string): string | null {
  if (!REMEMBER_PREFIX.test(input)) return null;

  const content = input.replace(REMEMBER_PREFIX, '').trim();
  return content === '' ? null : content;
}

/** A title from the opening words, since spoken captures never carry one. */
export function titleFromContent(content: string): string {
  const words = content.trim().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return 'Capture';

  let title = words.slice(0, TITLE_WORD_LIMIT).join(' ');
  if (title.length > TITLE_CHAR_LIMIT) {
    const clipped = title.slice(0, TITLE_CHAR_LIMIT);
    const lastSpace = clipped.lastIndexOf(' ');
    title = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
  }

  title = title.replace(TRAILING_PUNCTUATION, '');
  if (title === '') return 'Capture';

  return title.charAt(0).toUpperCase() + title.slice(1);
}

/**
 * A file-name stem for a title.
 *
 * Built from the normalised form, which keeps only letters and digits, so the
 * result cannot contain a separator or a traversal sequence however the title
 * was dictated.
 */
export function toSlug(title: string): string {
  const slug = normalise(title).split(' ').filter((part) => part !== '').join('-');
  return slug === '' ? 'capture' : slug;
}

/** YAML-safe scalar. JSON's escaping is a valid subset for a double-quoted value. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** The complete note to be written for a captured thought. */
export function draftCapture(content: string, options: DraftOptions = {}): CaptureDraft {
  const now = options.now ?? new Date();
  const taken = options.taken ?? new Set<string>();

  const text = content.trim();
  const title = titleFromContent(text);

  const base = toSlug(title);
  let slug = base;
  for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${base}-${suffix}`;

  const markdown = [
    '---',
    `title: ${yamlString(title)}`,
    `created: ${now.toISOString()}`,
    'source: helix-capture',
    '---',
    '',
    text,
    '',
  ].join('\n');

  return { title, slug, relativePath: `${CAPTURES_FOLDER}/${slug}.md`, content: text, markdown };
}

/**
 * The existing note a capture most resembles, or null if it resembles none.
 *
 * The new node is born at this one's position, so it arrives somewhere that
 * makes sense instead of drifting in from the edge of the galaxy.
 */
export function mostRelatedNode(galaxy: Galaxy, content: string): number | null {
  return selectNotes(galaxy, content, 1)[0]?.id ?? null;
}
