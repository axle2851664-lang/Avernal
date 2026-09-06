/**
 * Writing a captured thought into the vault.
 *
 * Separate from drafting it: `draftCapture` decides the title, the path and the
 * bytes without touching disk, and this puts them there.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';

import type { CaptureDraft } from '../../core/galaxy/capture.js';
import { CAPTURES_FOLDER } from '../../core/galaxy/capture.js';

/**
 * Slugs already used by captures in this vault.
 *
 * Passed to `draftCapture` as `taken`, so a second capture beginning with the
 * same words gets its own file instead of landing on the first one.
 */
export async function existingCaptureSlugs(root: string): Promise<Set<string>> {
  const slugs = new Set<string>();

  let entries: string[];
  try {
    entries = await readdir(join(root, CAPTURES_FOLDER));
  } catch {
    // No captures folder yet is the ordinary case on a first run.
    return slugs;
  }

  for (const entry of entries) {
    const parsed = parse(entry);
    if (parsed.ext.toLowerCase() === '.md') slugs.add(parsed.name);
  }

  return slugs;
}

/**
 * Writes a capture and returns its absolute path.
 *
 * Fails rather than overwrites if the file already exists: a capture is
 * something the user said out loud once, and silently replacing one would lose
 * it with no way to notice.
 *
 * The resolved path is checked to be inside the vault before anything is
 * written. `draftCapture` already builds slugs that cannot escape, so this is
 * the second lock on the same door — worth having, because the value passing
 * through it started as speech.
 */
export async function writeCapture(root: string, draft: CaptureDraft): Promise<string> {
  const vault = resolve(root);
  const target = resolve(vault, draft.relativePath);

  const inside = relative(vault, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`Refusing to write a capture outside the vault: ${draft.relativePath}`);
  }

  await mkdir(join(vault, CAPTURES_FOLDER), { recursive: true });
  await writeFile(target, draft.markdown, { encoding: 'utf8', flag: 'wx' });

  return target;
}
