/**
 * The notepad: reading, changing and removing notes already in the vault.
 *
 * This adds no store. The vault is where Helix's notes live — `writeCapture`
 * puts them there, `scanVault` reads them for the galaxy, and `groundedNotes`
 * searches them to answer a question — so a notepad with its own database
 * would be a second copy of the same notes, and the one Helix answers from
 * would be whichever the last write happened to touch.
 *
 * A note's id is its vault-relative path. It is stable, it is meaningful when
 * printed, and it needs no lookup table to stay in step with the disk. The
 * cost is that every id arriving from outside is a path, so every function
 * here resolves it and refuses anything that leaves the vault — the same lock
 * `writeCapture` puts on the door, on the other three verbs.
 */

import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { scanVault } from './scan.js';
import { frontMatterTitle } from '../../core/galaxy/text.js';

/** What a note carries besides its words. */
export interface NoteMeta {
  /** Vault-relative path, forward-slashed. Stable across platforms. */
  readonly id: string;
  readonly title: string;
  /** The folder holding it, which is the closest thing the vault has to a category. */
  readonly category: string;
  readonly tags: readonly string[];
  /** ISO timestamps. `created` comes from the front matter when it is there. */
  readonly created: string;
  readonly updated: string;
  readonly words: number;
  /** First line or so, for a list. Never the whole note. */
  readonly excerpt: string;
}

export interface Note extends NoteMeta {
  /** The note as written, front matter stripped. */
  readonly content: string;
}

export class NotepadError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = 'NotepadError';
    this.status = status;
  }
}

const MARKDOWN = /\.(?:md|markdown)$/i;
const EXCERPT_LENGTH = 140;

/**
 * Turn an id from outside into a path inside the vault, or refuse.
 *
 * Every rejection here is something that should never arrive from Helix's own
 * screens, which is exactly why it is checked: the ids come back over HTTP and
 * nothing stops a different caller inventing one.
 */
function resolveNote(root: string, id: unknown): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new NotepadError('No note was named.', 400);
  }
  // Backslashes are separators on Windows, so a "safe" id containing one would
  // be a traversal there and a filename here.
  if (id.includes('\\') || id.includes('\0')) {
    throw new NotepadError('That is not a note id.', 400);
  }
  if (!MARKDOWN.test(id)) {
    throw new NotepadError('That is not a note id.', 400);
  }

  const vault = resolve(root);
  const target = resolve(vault, id);
  const inside = relative(vault, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new NotepadError('That note is not in the vault.', 400);
  }
  return target;
}

/** Front matter, when there is any, and the body that follows it. */
function splitFrontMatter(markdown: string): { front: string; body: string } {
  if (!markdown.startsWith('---')) return { front: '', body: markdown };
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return { front: '', body: markdown };

  const afterFence = markdown.indexOf('\n', end + 1);
  return {
    front: markdown.slice(0, afterFence === -1 ? markdown.length : afterFence + 1),
    body: afterFence === -1 ? '' : markdown.slice(afterFence + 1),
  };
}

function frontMatterValue(front: string, key: string): string | null {
  const match = new RegExp('^' + key + ':\\s*(.+)$', 'mi').exec(front);
  if (match === null) return null;
  return (match[1] ?? '').trim().replace(/^["']|["']$/g, '');
}

/**
 * Tags, from the front matter.
 *
 * Both shapes written in the wild are read — `tags: a, b` and a YAML list —
 * because the vault is a folder of markdown files and a person may well have
 * typed either into one by hand.
 */
function frontMatterTags(front: string): string[] {
  const inline = frontMatterValue(front, 'tags');
  if (inline !== null && inline !== '' && !inline.startsWith('[')) {
    return inline
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
  }
  if (inline !== null && inline.startsWith('[')) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
      .filter((tag) => tag !== '');
  }
  const listed = [...front.matchAll(/^\s*-\s+(.+)$/gm)].map((m) => (m[1] ?? '').trim());
  return front.includes('tags:') ? listed.filter((tag) => tag !== '') : [];
}

function excerptFrom(body: string): string {
  const flat = body.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_LENGTH) return flat;
  const clipped = flat.slice(0, EXCERPT_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped) + '…';
}

function countWords(body: string): number {
  const trimmed = body.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

function categoryOf(id: string): string {
  const at = id.lastIndexOf('/');
  return at === -1 ? 'root' : id.slice(0, at);
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

async function describe(root: string, id: string): Promise<Note> {
  const target = resolveNote(root, id);

  let markdown: string;
  try {
    markdown = await readFile(target, 'utf8');
  } catch {
    throw new NotepadError('There is no note with that name.', 404);
  }

  const stats = await stat(target);
  const { front, body } = splitFrontMatter(markdown);
  const content = body.trim();

  return {
    id,
    title: frontMatterTitle(markdown) ?? id.slice(id.lastIndexOf('/') + 1).replace(MARKDOWN, ''),
    category: categoryOf(id),
    tags: frontMatterTags(front),
    // A note written by hand may have no front matter at all, and birthtime is
    // not recorded on every filesystem — modification time is the honest
    // fallback in both cases.
    created: frontMatterValue(front, 'created') ?? stats.birthtime.toISOString(),
    updated: stats.mtime.toISOString(),
    words: countWords(content),
    excerpt: excerptFrom(content),
    content,
  };
}

/** Every note in the vault, newest change first. */
export async function listNotes(root: string): Promise<readonly NoteMeta[]> {
  // scanVault already walks the vault, skips what should be skipped, and
  // returns a stable order. Re-walking here would be a second implementation
  // of the same rules, which would drift.
  const sources = await scanVault(root);

  const notes = await Promise.all(
    sources.map(async (source) => {
      const { content: _content, ...meta } = await describe(root, toPosix(source.key));
      return meta;
    })
  );

  return [...notes].sort((a, b) => b.updated.localeCompare(a.updated));
}

/** One note, in full. */
export async function readNote(root: string, id: unknown): Promise<Note> {
  return describe(root, toPosix(String(id)));
}

export interface NotePatch {
  readonly title?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
}

/**
 * Change a note.
 *
 * The front matter is rewritten rather than patched in place: it is a handful
 * of known keys, and preserving unknown ones from a file the user may have
 * edited by hand is the kind of half-measure that loses them silently. What is
 * kept is the created date, which is the one value that cannot be recovered.
 */
export async function updateNote(root: string, id: unknown, patch: NotePatch): Promise<Note> {
  const noteId = toPosix(String(id));
  const existing = await describe(root, noteId);
  const target = resolveNote(root, noteId);

  const title = patch.title === undefined ? existing.title : patch.title.trim();
  if (title === '') throw new NotepadError('A note needs a title.', 400);

  const content = patch.content === undefined ? existing.content : patch.content;
  const tags = (patch.tags === undefined ? existing.tags : patch.tags)
    .map((tag) => String(tag).trim())
    .filter((tag) => tag !== '');

  const front = [
    '---',
    'title: ' + JSON.stringify(title),
    'created: ' + existing.created,
    ...(tags.length === 0 ? [] : ['tags: ' + tags.join(', ')]),
    'source: helix-notepad',
    '---',
    '',
  ].join('\n');

  await writeFile(target, front + content.trim() + '\n', 'utf8');
  return describe(root, noteId);
}

/**
 * Delete a note.
 *
 * Gone from the vault means gone from the galaxy and gone from what Helix can
 * answer with, which is the point — but it is also why nothing here deletes
 * more than the one file it was given.
 */
export async function removeNote(root: string, id: unknown): Promise<NoteMeta> {
  const noteId = toPosix(String(id));
  const { content: _content, ...meta } = await describe(root, noteId);
  await rm(resolveNote(root, noteId));
  return meta;
}

/**
 * Notes matching a search, best first.
 *
 * Deliberately not the same search `/ask` uses: that one scores notes for
 * whether they answer a question, and this one is a person looking for a note
 * they know exists. Title first, then tags, then the body.
 */
export async function searchNotes(root: string, query: string): Promise<readonly NoteMeta[]> {
  const needle = query.trim().toLowerCase();
  if (needle === '') return listNotes(root);

  const sources = await scanVault(root);
  const scored: { note: NoteMeta; score: number }[] = [];

  for (const source of sources) {
    const { content, ...meta } = await describe(root, toPosix(source.key));
    const title = meta.title.toLowerCase();

    let score = 0;
    if (title === needle) score += 100;
    else if (title.includes(needle)) score += 50;
    if (meta.tags.some((tag) => tag.toLowerCase().includes(needle))) score += 20;
    if (meta.category.toLowerCase().includes(needle)) score += 5;

    const body = content.toLowerCase();
    if (body.includes(needle)) score += 10;

    if (score > 0) scored.push({ note: meta, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || b.note.updated.localeCompare(a.note.updated))
    .map((hit) => hit.note);
}

/** The vault's own folder join, so callers do not have to know the layout. */
export function notePath(root: string, id: string): string {
  return join(resolve(root), id);
}
