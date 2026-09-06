import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROOT_GROUP, scanVault } from '../scan.js';
import { existingCaptureSlugs, writeCapture } from '../write.js';
import { draftCapture } from '../../../core/galaxy/capture.js';
import { buildGalaxy } from '../../../core/galaxy/graph.js';

let vault: string;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'helix-vault-'));
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

async function put(relativePath: string, contents: string): Promise<void> {
  const full = join(vault, relativePath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

describe('scanVault', () => {
  it('finds notes at the root and in folders', async () => {
    await put('Index.md', 'top level');
    await put('architecture/Storage Ceiling.md', 'bounded');

    const notes = await scanVault(vault);

    expect(notes.map((n) => n.key)).toEqual(['Index.md', 'architecture/Storage Ceiling.md']);
    expect(notes.map((n) => n.text)).toEqual(['top level', 'bounded']);
  });

  it('takes the group from the containing folder', async () => {
    await put('Index.md', 'x');
    await put('architecture/Paths.md', 'y');
    await put('a/b/Deep.md', 'z');

    const notes = await scanVault(vault);

    expect(notes.map((n) => n.group)).toEqual([ROOT_GROUP, 'b', 'architecture']);
  });

  it('reads the label from the filename, with separators as spaces', async () => {
    await put('portable-mode.md', 'x');
    await put('hand_tracking.md', 'y');

    const notes = await scanVault(vault);

    expect(notes.map((n) => n.label)).toEqual(['hand tracking', 'portable mode']);
  });

  it('orders notes by path so ids do not shift between runs or machines', async () => {
    for (const name of ['zeta.md', 'alpha.md', 'middle.md']) await put(name, 'x');

    const first = await scanVault(vault);
    const second = await scanVault(vault);

    expect(first.map((n) => n.key)).toEqual(['alpha.md', 'middle.md', 'zeta.md']);
    expect(second.map((n) => n.key)).toEqual(first.map((n) => n.key));
  });

  it('ignores non-markdown files', async () => {
    await put('Note.md', 'keep');
    await put('image.png', 'drop');
    await put('script.ts', 'drop');

    expect((await scanVault(vault)).map((n) => n.key)).toEqual(['Note.md']);
  });

  it('accepts the .markdown extension', async () => {
    await put('Long.markdown', 'x');
    expect((await scanVault(vault)).map((n) => n.label)).toEqual(['Long']);
  });

  it('skips build output, version control and hidden directories', async () => {
    await put('Keep.md', 'x');
    await put('node_modules/pkg/README.md', 'drop');
    await put('.git/COMMIT_EDITMSG.md', 'drop');
    await put('.obsidian/config.md', 'drop');
    await put('dist/out.md', 'drop');

    expect((await scanVault(vault)).map((n) => n.key)).toEqual(['Keep.md']);
  });

  it('skips extra directories on request', async () => {
    await put('Keep.md', 'x');
    await put('archive/Old.md', 'drop');

    const notes = await scanVault(vault, { ignore: ['archive'] });
    expect(notes.map((n) => n.key)).toEqual(['Keep.md']);
  });

  it('returns nothing for an empty vault rather than failing', async () => {
    expect(await scanVault(vault)).toEqual([]);
  });

  it('produces notes the galaxy can build from directly', async () => {
    await put('architecture/Storage Ceiling.md', 'Bounded at forty gigabytes.');
    await put('architecture/Portable Mode.md', 'See [[Storage Ceiling]].');

    const galaxy = buildGalaxy(await scanVault(vault));

    expect(galaxy.nodes.map((n) => n.label)).toEqual(['Portable Mode', 'Storage Ceiling']);
    expect(galaxy.links).toEqual([{ source: 0, target: 1, kind: 'wikilink' }]);
  });
});

describe('existingCaptureSlugs', () => {
  it('is empty when no captures folder exists yet', async () => {
    expect(await existingCaptureSlugs(vault)).toEqual(new Set());
  });

  it('lists the slugs already taken', async () => {
    await put('captures/buy-milk.md', 'x');
    await put('captures/the-ceiling.md', 'y');
    await put('captures/notes.txt', 'ignored');

    expect(await existingCaptureSlugs(vault)).toEqual(new Set(['buy-milk', 'the-ceiling']));
  });
});

describe('writeCapture', () => {
  it('writes the note into the captures folder, creating it if needed', async () => {
    const draft = draftCapture('the ceiling is 40GB', { now: new Date('2026-09-06T01:30:00.000Z') });
    const path = await writeCapture(vault, draft);

    expect(path).toBe(join(vault, 'captures', 'the-ceiling-is-40gb.md'));
    expect(await readFile(path, 'utf8')).toBe(draft.markdown);
  });

  it('refuses to overwrite an existing capture', async () => {
    const draft = draftCapture('buy milk');

    await writeCapture(vault, draft);
    await expect(writeCapture(vault, draft)).rejects.toThrow();
  });

  it('gives a second capture of the same words its own file', async () => {
    const first = draftCapture('buy milk');
    await writeCapture(vault, first);

    const second = draftCapture('buy milk', { taken: await existingCaptureSlugs(vault) });
    const path = await writeCapture(vault, second);

    expect(second.slug).toBe('buy-milk-2');
    expect(path).toBe(join(vault, 'captures', 'buy-milk-2.md'));
  });

  it('refuses a draft whose path would escape the vault', async () => {
    const escaping = { ...draftCapture('anything'), relativePath: '../outside.md' };

    await expect(writeCapture(vault, escaping)).rejects.toThrow(/outside the vault/);
  });

  it('writes a capture the scanner then picks up', async () => {
    await put('architecture/Storage Ceiling.md', 'Bounded at forty gigabytes.');
    await writeCapture(vault, draftCapture('the storage ceiling moved to 80GB'));

    const notes = await scanVault(vault);
    const capture = notes.find((note) => note.group === 'captures');

    expect(capture?.label).toBe('The storage ceiling moved to 80GB');
    expect(capture?.text).toContain('the storage ceiling moved to 80GB');
  });
});
