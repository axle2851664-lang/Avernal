import { describe, expect, it } from 'vitest';

import {
  CAPTURES_FOLDER,
  draftCapture,
  mostRelatedNode,
  parseRememberCommand,
  titleFromContent,
  toSlug,
} from '../capture.js';
import { appendNote, buildGalaxy } from '../graph.js';
import type { NoteSource } from '../types.js';

function note(label: string, text: string, group = 'notes'): NoteSource {
  return { key: `${group}/${label}.md`, label, group, text };
}

const AT = new Date('2026-09-06T01:30:00.000Z');

describe('parseRememberCommand', () => {
  it('takes the text after "remember that"', () => {
    expect(parseRememberCommand('remember that the ceiling is 40GB')).toBe('the ceiling is 40GB');
  });

  it('accepts a dropped "that", which transcripts often lose', () => {
    expect(parseRememberCommand('remember the ceiling is 40GB')).toBe('the ceiling is 40GB');
  });

  it('is case-insensitive and tolerates leading space', () => {
    expect(parseRememberCommand('  Remember That it ships Friday')).toBe('it ships Friday');
  });

  it('strips the punctuation a transcript leaves behind', () => {
    expect(parseRememberCommand('Remember that... the drive is failing')).toBe('the drive is failing');
    expect(parseRememberCommand('remember: buy milk')).toBe('buy milk');
  });

  it('returns null for anything that is not a capture', () => {
    expect(parseRememberCommand('what is the storage ceiling?')).toBeNull();
    expect(parseRememberCommand('do you remember the ceiling?')).toBeNull();
  });

  it('returns null when nothing was actually said', () => {
    expect(parseRememberCommand('remember that')).toBeNull();
    expect(parseRememberCommand('remember')).toBeNull();
  });
});

describe('titleFromContent', () => {
  it('uses the opening words, capitalised', () => {
    expect(titleFromContent('the ceiling is 40GB')).toBe('The ceiling is 40GB');
  });

  it('stops at eight words', () => {
    expect(titleFromContent('one two three four five six seven eight nine ten')).toBe(
      'One two three four five six seven eight',
    );
  });

  it('drops trailing punctuation', () => {
    expect(titleFromContent('buy milk.')).toBe('Buy milk');
  });

  it('stays short even for one long run of words', () => {
    expect(titleFromContent('a '.repeat(80)).length).toBeLessThanOrEqual(60);
  });

  it('falls back rather than returning an empty title', () => {
    expect(titleFromContent('   ')).toBe('Capture');
    expect(titleFromContent('...')).toBe('Capture');
  });
});

describe('toSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(toSlug('The Ceiling Is 40GB')).toBe('the-ceiling-is-40gb');
  });

  it('cannot produce a path separator or a traversal', () => {
    expect(toSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(toSlug('..')).toBe('capture');
    expect(toSlug('a/b\\c')).toBe('a-b-c');
  });

  it('falls back when nothing survives normalisation', () => {
    expect(toSlug('!!!')).toBe('capture');
  });
});

describe('draftCapture', () => {
  it('writes into the captures folder with front matter and the spoken text', () => {
    const draft = draftCapture('the ceiling is 40GB', { now: AT });

    expect(draft.title).toBe('The ceiling is 40GB');
    expect(draft.relativePath).toBe(`${CAPTURES_FOLDER}/the-ceiling-is-40gb.md`);
    expect(draft.markdown).toBe(
      [
        '---',
        'title: "The ceiling is 40GB"',
        'created: 2026-09-06T01:30:00.000Z',
        'source: helix-capture',
        '---',
        '',
        'the ceiling is 40GB',
        '',
      ].join('\n'),
    );
  });

  it('never overwrites an existing capture', () => {
    const taken = new Set(['buy-milk', 'buy-milk-2']);
    const draft = draftCapture('buy milk', { now: AT, taken });

    expect(draft.slug).toBe('buy-milk-3');
    expect(draft.relativePath).toBe(`${CAPTURES_FOLDER}/buy-milk-3.md`);
  });

  it('escapes a title that would otherwise break the front matter', () => {
    const draft = draftCapture('he said "hello": then left', { now: AT });

    expect(draft.markdown).toContain('title: "He said \\"hello\\": then left"');
  });
});

describe('mostRelatedNode', () => {
  const galaxy = buildGalaxy([
    note('Storage Ceiling', 'How much disk the assistant may consume.', 'architecture'),
    note('Voice', 'Speaking and listening.', 'interface'),
  ]);

  it('finds the note a capture belongs beside', () => {
    expect(mostRelatedNode(galaxy, 'the storage ceiling is now 40GB')).toBe(0);
    expect(mostRelatedNode(galaxy, 'the voice is too quiet')).toBe(1);
  });

  it('returns null when a capture resembles nothing', () => {
    expect(mostRelatedNode(galaxy, 'sourdough starter needs feeding')).toBeNull();
  });
});

describe('appendNote', () => {
  const notes = [
    note('Storage Ceiling', 'Bounded at forty gigabytes.'),
    note('Voice', 'Speaks and listens.'),
  ];

  it('gives the new note the next id and leaves existing ids untouched', () => {
    const before = buildGalaxy(notes);
    const after = appendNote(notes, note('Capture', 'The storage ceiling moved.', CAPTURES_FOLDER));

    expect(after.nodes).toHaveLength(3);
    expect(after.nodes[2]?.id).toBe(2);
    expect(after.nodes.slice(0, 2).map((n) => n.label)).toEqual(
      before.nodes.map((n) => n.label),
    );
  });

  it('links the new note into the graph immediately', () => {
    const after = appendNote(notes, note('Capture', 'Revisit the [[Storage Ceiling]] soon.', CAPTURES_FOLDER));

    expect(after.links).toContainEqual({ source: 0, target: 2, kind: 'wikilink' });
  });

  it('carries the captures folder through as the group', () => {
    const after = appendNote(notes, note('Capture', 'Something.', CAPTURES_FOLDER));
    expect(after.nodes[2]?.group).toBe(CAPTURES_FOLDER);
  });
});
