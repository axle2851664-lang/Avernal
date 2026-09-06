import { describe, expect, it } from 'vitest';

import { assertGalaxyIntegrity, buildGalaxy } from '../graph.js';
import type { Galaxy, NoteSource } from '../types.js';

function note(label: string, text: string, group = 'notes'): NoteSource {
  return { key: `${group}/${label}.md`, label, group, text };
}

function linkBetween(galaxy: Galaxy, a: number, b: number) {
  const source = Math.min(a, b);
  const target = Math.max(a, b);
  return galaxy.links.find((link) => link.source === source && link.target === target);
}

describe('buildGalaxy', () => {
  it('gives every node an id equal to its index', () => {
    const galaxy = buildGalaxy([
      note('Alpha', 'first'),
      note('Beta', 'second'),
      note('Gamma', 'third'),
    ]);

    expect(galaxy.nodes.map((n) => n.id)).toEqual([0, 1, 2]);
    expect(() => assertGalaxyIntegrity(galaxy)).not.toThrow();
  });

  it('links notes joined by a wikilink', () => {
    const galaxy = buildGalaxy([
      note('Storage Ceiling', 'Bounded by the [[Portable Mode]] rules.'),
      note('Portable Mode', 'Runs from a drive.'),
    ]);

    expect(linkBetween(galaxy, 0, 1)).toEqual({ source: 0, target: 1, kind: 'wikilink' });
  });

  it('resolves wikilink aliases, headings and paths to the same note', () => {
    const target = note('Portable Mode', 'Runs from a drive.');

    for (const body of ['[[Portable Mode|the portable rules]]', '[[Portable Mode#Paths]]', '[[docs/Portable Mode]]']) {
      const galaxy = buildGalaxy([note('Source', body), target]);
      expect(linkBetween(galaxy, 0, 1)?.kind).toBe('wikilink');
    }
  });

  it('links a note that mentions another note title in prose', () => {
    const galaxy = buildGalaxy([
      note('Event Bus', 'Typed pub/sub.'),
      note('Kernel', 'The kernel wires the event bus into every module.'),
    ]);

    expect(linkBetween(galaxy, 0, 1)).toEqual({ source: 0, target: 1, kind: 'mention' });
  });

  it('matches titles regardless of case and separator style', () => {
    const galaxy = buildGalaxy([
      note('Hand-Tracking', 'Pinch to move.'),
      note('Gestures', 'Built on hand tracking, which reveals actions.'),
    ]);

    expect(linkBetween(galaxy, 0, 1)?.kind).toBe('mention');
  });

  it('does not match a title inside a longer word', () => {
    const galaxy = buildGalaxy([
      note('Art', 'Short title.'),
      note('Other', 'This note is about a cartographer, not the subject.'),
    ]);

    expect(galaxy.links).toHaveLength(0);
  });

  it('ignores titles shorter than the mention threshold', () => {
    const galaxy = buildGalaxy([
      note('AI', 'Short.'),
      note('Essay', 'This paragraph is about AI and nothing else.'),
    ]);

    expect(galaxy.links).toHaveLength(0);
  });

  it('never links a note to itself, even when it names itself', () => {
    const galaxy = buildGalaxy([note('Recursion', 'Recursion explains recursion. See [[Recursion]].')]);
    expect(galaxy.links).toHaveLength(0);
  });

  it('records one undirected link when two notes reference each other', () => {
    const galaxy = buildGalaxy([
      note('Alpha', 'Points at [[Beta]].'),
      note('Beta', 'Points back at [[Alpha]].'),
    ]);

    expect(galaxy.links).toEqual([{ source: 0, target: 1, kind: 'wikilink' }]);
  });

  it('prefers the wikilink reason when a pair both links and mentions', () => {
    const galaxy = buildGalaxy([
      note('Alpha', 'Beta is discussed here.'),
      note('Beta', 'See [[Alpha]] for background.'),
    ]);

    expect(galaxy.links).toEqual([{ source: 0, target: 1, kind: 'wikilink' }]);
  });

  it('resolves an ambiguous wikilink to every note sharing the title', () => {
    const galaxy = buildGalaxy([
      note('Index', 'Start at [[Setup]].'),
      note('Setup', 'Windows steps.', 'windows'),
      note('Setup', 'Linux steps.', 'linux'),
    ]);

    expect(linkBetween(galaxy, 0, 1)?.kind).toBe('wikilink');
    expect(linkBetween(galaxy, 0, 2)?.kind).toBe('wikilink');
  });

  it('carries the folder through as the group', () => {
    const galaxy = buildGalaxy([note('Paths', 'text', 'architecture')]);
    expect(galaxy.nodes[0]?.group).toBe('architecture');
  });

  it('returns links in a stable order', () => {
    const notes = [
      note('Alpha', 'See [[Gamma]].'),
      note('Beta', 'See [[Alpha]].'),
      note('Gamma', 'Standalone.'),
    ];

    expect(buildGalaxy(notes).links).toEqual(buildGalaxy(notes).links);
    expect(buildGalaxy(notes).links.map((l) => [l.source, l.target])).toEqual([[0, 1], [0, 2]]);
  });
});

describe('assertGalaxyIntegrity', () => {
  it('rejects a node whose id is not its index', () => {
    const galaxy: Galaxy = {
      nodes: [{ id: 7, key: 'a.md', label: 'A', group: 'g', excerpt: '' }],
      links: [],
    };

    expect(() => assertGalaxyIntegrity(galaxy)).toThrow(/must equal the index/);
  });

  it('rejects a link pointing outside the node array', () => {
    const galaxy: Galaxy = {
      nodes: [{ id: 0, key: 'a.md', label: 'A', group: 'g', excerpt: '' }],
      links: [{ source: 0, target: 4, kind: 'mention' }],
    };

    expect(() => assertGalaxyIntegrity(galaxy)).toThrow(/outside/);
  });
});
