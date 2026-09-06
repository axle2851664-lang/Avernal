import { describe, expect, it } from 'vitest';

import { buildGalaxy } from '../graph.js';
import { selectNotes, tokenise, warmSearchIndex } from '../retrieval.js';
import type { NoteSource } from '../types.js';

function note(label: string, text: string, group = 'notes'): NoteSource {
  return { key: `${group}/${label}.md`, label, group, text };
}

const galaxy = buildGalaxy([
  note('Storage Ceiling', 'The ceiling bounds how much disk Helix may consume.', 'architecture'),
  note('Portable Mode', 'Paths resolve so the assistant survives a drive-letter change.', 'architecture'),
  note('Voice', 'Listening and speaking through the browser speech engine.', 'interface'),
]);

describe('tokenise', () => {
  it('drops stop words and single characters', () => {
    expect(tokenise('What is the storage ceiling?')).toEqual(['storage', 'ceiling']);
  });

  it('de-duplicates repeated terms', () => {
    expect(tokenise('storage storage ceiling')).toEqual(['storage', 'ceiling']);
  });

  it('returns nothing for a question made only of stop words', () => {
    expect(tokenise('what is it')).toEqual([]);
  });
});

describe('selectNotes', () => {
  it('ranks the note whose title matches above one that only mentions the term', () => {
    const [first] = selectNotes(galaxy, 'storage ceiling');
    expect(first?.id).toBe(0);
  });

  it('weighs a title hit more heavily than a body hit', () => {
    const titleMatch = selectNotes(galaxy, 'voice').find((n) => n.id === 2);
    const bodyMatch = selectNotes(galaxy, 'speaking').find((n) => n.id === 2);

    expect(titleMatch?.score).toBeGreaterThan(bodyMatch?.score ?? 0);
  });

  it('leaves out notes with no overlap at all', () => {
    expect(selectNotes(galaxy, 'voice').map((n) => n.id)).toEqual([2]);
  });

  it('returns nothing for a question with no usable terms', () => {
    expect(selectNotes(galaxy, 'what is it')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(selectNotes(galaxy, 'the assistant paths ceiling voice', 2)).toHaveLength(2);
    expect(selectNotes(galaxy, 'ceiling', 0)).toEqual([]);
  });

  it('defaults to six notes', () => {
    const many = buildGalaxy(
      Array.from({ length: 10 }, (_, i) => note(`Topic ${i}`, 'shared keyword storage here')),
    );

    expect(selectNotes(many, 'storage')).toHaveLength(6);
  });

  it('breaks ties towards the lower id so answers are reproducible', () => {
    const tied = buildGalaxy([
      note('One', 'shared keyword'),
      note('Two', 'shared keyword'),
      note('Three', 'shared keyword'),
    ]);

    expect(selectNotes(tied, 'shared').map((n) => n.id)).toEqual([0, 1, 2]);
  });

  it('scores against the group as well as the text', () => {
    expect(selectNotes(galaxy, 'architecture').map((n) => n.id)).toEqual([0, 1]);
  });

  it('returns ids usable as direct indices into nodes', () => {
    for (const { id } of selectNotes(galaxy, 'storage ceiling voice')) {
      expect(galaxy.nodes[id]?.id).toBe(id);
    }
  });
});

describe('search index caching', () => {
  it('returns identical results on repeated queries', () => {
    const first = selectNotes(galaxy, 'storage ceiling voice');
    const second = selectNotes(galaxy, 'storage ceiling voice');
    const third = selectNotes(galaxy, 'storage ceiling voice');

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('gives the same answer warm as cold', () => {
    const cold = buildGalaxy([
      note('Storage Ceiling', 'The ceiling bounds how much disk Helix may consume.', 'architecture'),
      note('Voice', 'Listening and speaking.', 'interface'),
    ]);

    const warm = buildGalaxy([
      note('Storage Ceiling', 'The ceiling bounds how much disk Helix may consume.', 'architecture'),
      note('Voice', 'Listening and speaking.', 'interface'),
    ]);
    warmSearchIndex(warm);

    expect(selectNotes(warm, 'storage ceiling')).toEqual(selectNotes(cold, 'storage ceiling'));
  });

  it('does not serve a stale index to a rebuilt galaxy', () => {
    const before = buildGalaxy([note('Voice', 'Speaks.')]);
    expect(selectNotes(before, 'sourdough')).toEqual([]);

    const after = buildGalaxy([note('Voice', 'Speaks.'), note('Sourdough', 'Starter needs feeding.')]);
    expect(selectNotes(after, 'sourdough').map((n) => n.id)).toEqual([1]);
  });
});
