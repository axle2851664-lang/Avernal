import { describe, expect, it } from 'vitest';

import { SYSTEM_PROMPT, bootGreeting, renderNotesContext } from '../persona.js';
import { buildGalaxy } from '../graph.js';
import { groundedNotes } from '../retrieval.js';
import type { NoteSource } from '../types.js';

function note(label: string, text: string, group = 'notes'): NoteSource {
  return { key: `${group}/${label}.md`, label, group, text };
}

const galaxy = buildGalaxy([
  note('Storage Ceiling', 'Bounded at forty gigabytes.', 'architecture'),
  note('Voice', 'Speaks and listens.', 'interface'),
]);

describe('SYSTEM_PROMPT', () => {
  it('forbids reciting the note that is already on screen', () => {
    expect(SYSTEM_PROMPT).toMatch(/never recite/i);
  });

  it('confines facts to the supplied notes and forbids invention', () => {
    expect(SYSTEM_PROMPT).toMatch(/nothing from your own knowledge/i);
    expect(SYSTEM_PROMPT).toMatch(/inventing/i);
  });

  it('tells it to admit a gap', () => {
    expect(SYSTEM_PROMPT).toMatch(/do not cover it/i);
  });

  it('keeps answers to one or two sentences', () => {
    expect(SYSTEM_PROMPT).toMatch(/never three/i);
  });

  it('rations the "sir"', () => {
    expect(SYSTEM_PROMPT).toMatch(/sparingly/i);
  });

  it('handles small talk without reaching for the vault', () => {
    expect(SYSTEM_PROMPT).toMatch(/do not mention the notes/i);
  });
});

describe('renderNotesContext', () => {
  it('renders each note with its id, label and group', () => {
    const context = renderNotesContext(galaxy, groundedNotes(galaxy, 'storage ceiling'));

    expect(context).toContain('[0] Storage Ceiling (architecture)');
    expect(context).toContain('Bounded at forty gigabytes.');
  });

  it('returns nothing at all when no note qualified', () => {
    expect(renderNotesContext(galaxy, [])).toBe('');
  });

  it('skips sources that do not resolve to a node', () => {
    expect(renderNotesContext(galaxy, [{ id: 99, score: 10 }])).toBe('');
  });
});

describe('bootGreeting', () => {
  it('reports the real note count and follows the requested phrasing', () => {
    const evening = new Date('2026-09-06T20:00:00');

    expect(bootGreeting(128, evening)).toBe(
      'Good evening, sir. 128 notes indexed, all present and accounted for.',
    );
  });

  it('follows the clock rather than always saying evening', () => {
    expect(bootGreeting(5, new Date('2026-09-06T09:00:00')).startsWith('Good morning, sir.')).toBe(true);
    expect(bootGreeting(5, new Date('2026-09-06T14:00:00')).startsWith('Good afternoon, sir.')).toBe(true);
    expect(bootGreeting(5, new Date('2026-09-06T23:00:00')).startsWith('Good evening, sir.')).toBe(true);
  });

  it('does not say "1 notes"', () => {
    expect(bootGreeting(1, new Date('2026-09-06T20:00:00'))).toContain('1 note indexed');
  });

  it('says something sensible when the vault is empty', () => {
    const greeting = bootGreeting(0, new Date('2026-09-06T20:00:00'));

    expect(greeting.startsWith('Good evening, sir.')).toBe(true);
    expect(greeting).not.toContain('0 notes');
    expect(greeting).not.toContain('present and accounted for');
  });
});
