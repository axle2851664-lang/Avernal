/**
 * Reading a vault of markdown notes off disk.
 *
 * The galaxy identifies notes by their position in an array, so the order this
 * returns is part of the contract: notes are sorted by path, never left in
 * directory order, which varies by filesystem and platform. Helix runs from a
 * portable drive across machines — unsorted reads would renumber every node
 * simply by moving the drive.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, parse, sep } from 'node:path';

import type { NoteSource } from '../../core/galaxy/types.js';
import { frontMatterTitle } from '../../core/galaxy/text.js';

/** Group given to notes sitting directly in the vault root. */
export const ROOT_GROUP = 'root';

const MARKDOWN = /\.(?:md|markdown)$/i;

/** Never descended into: build output, version control, and hidden directories. */
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.git']);

export interface ScanOptions {
  /** Extra directory names to skip, alongside the defaults. */
  readonly ignore?: readonly string[];
}

/** Paths are keyed with forward slashes so a note's key survives moving between platforms. */
function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** "portable-mode" and "portable_mode" both read as "portable mode". */
function labelFromFilename(filename: string): string {
  return parse(filename).name.replace(/[-_]+/g, ' ').trim();
}

async function walk(
  root: string,
  relative: string,
  ignored: ReadonlySet<string>,
  found: string[],
): Promise<void> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });

  for (const entry of entries) {
    const childRelative = relative === '' ? entry.name : join(relative, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
      await walk(root, childRelative, ignored, found);
      continue;
    }

    if (entry.isFile() && MARKDOWN.test(entry.name) && !entry.name.startsWith('.')) {
      found.push(childRelative);
    }
  }
}

/**
 * Every markdown note under `root`, ordered by path.
 *
 * A note's label comes from its file name and its group from the folder holding
 * it, which is what gives the galaxy its colour coding.
 */
export async function scanVault(root: string, options: ScanOptions = {}): Promise<NoteSource[]> {
  const ignored = new Set([...IGNORED_DIRECTORIES, ...(options.ignore ?? [])]);

  const relativePaths: string[] = [];
  await walk(root, '', ignored, relativePaths);

  const keys = relativePaths.map(toPosix).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const notes: NoteSource[] = [];
  for (const key of keys) {
    const text = await readFile(join(root, key), 'utf8');
    const segments = key.split('/');
    const filename = segments[segments.length - 1] ?? key;
    const parent = segments.length > 1 ? segments[segments.length - 2] : undefined;

    notes.push({
      key,
      label: frontMatterTitle(text) ?? labelFromFilename(filename),
      group: parent ?? ROOT_GROUP,
      text,
    });
  }

  return notes;
}
