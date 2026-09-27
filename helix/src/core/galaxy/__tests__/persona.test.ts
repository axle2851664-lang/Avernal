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
    expect(SYSTEM_PROMPT).toMatch(/something you made up/i);
  });

  it('tells it to admit a gap', () => {
    expect(SYSTEM_PROMPT).toMatch(/do not cover it/i);
    expect(SYSTEM_PROMPT).toContain("I don't have enough information.");
  });

  it('keeps answers to one or two sentences', () => {
    expect(SYSTEM_PROMPT).toMatch(/never three/i);
  });

  it('bans every honorific, and inventing new ones', () => {
    // The whole point of the rewrite. A prompt that merely omits "sir" gets
    // one back the moment the model reaches for a register it knows.
    for (const title of ['sir', 'boss', 'captain', 'master', 'mr']) {
      expect(SYSTEM_PROMPT).toContain('"' + title + '"');
    }
    expect(SYSTEM_PROMPT).toMatch(/never invent an honorific/i);
    expect(SYSTEM_PROMPT).toMatch(/do not address the user at all in most replies/i);
  });

  it('allows a name only when a remembered preference sets one', () => {
    // Memory is the only channel a name can arrive on, so the licence has to
    // name it — otherwise the model invents a familiar form of its own.
    expect(SYSTEM_PROMPT).toMatch(/remembered preference .* explicitly states what to call them/i);
  });

  it('licenses dry humour and rations it', () => {
    expect(SYSTEM_PROMPT).toMatch(/dry, infrequent/i);
    expect(SYSTEM_PROMPT).toMatch(/one reply in five/i);
    expect(SYSTEM_PROMPT).toMatch(/never a run of quips/i);
  });

  it('keeps the jokes off what people are rather than what they do', () => {
    // The one line in the character that is load-bearing rather than
    // decorative: it is what separates a dry assistant from a liability.
    expect(SYSTEM_PROMPT).toMatch(/what someone is rather than what they did/i);
  });

  it('separates the states it is allowed to claim', () => {
    // Saying "done" about a plan is the failure mode this section exists for.
    for (const state of [
      'answering',
      'thinking',
      'planning',
      'executing',
      'awaiting confirmation',
      'failed',
    ]) {
      expect(SYSTEM_PROMPT).toContain(state);
    }
    expect(SYSTEM_PROMPT).toMatch(/never describe an action as done when it has not happened/i);
  });

  it('gives it the plain sentences for the cases it cannot talk its way out of', () => {
    expect(SYSTEM_PROMPT).toContain("I can't do that from here.");
    expect(SYSTEM_PROMPT).toContain('I need permission to continue.');
    expect(SYSTEM_PROMPT).toContain("The operation failed. I'm checking why.");
  });

  it('keeps the composure from curdling into contempt', () => {
    expect(SYSTEM_PROMPT).toMatch(/confident, never rude/i);
    expect(SYSTEM_PROMPT).toMatch(/you are on their side/i);
  });

  it('does not assume the user is a man', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\b(his|him|he)\b/i);
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
  it('reports the real note count as a statement of state', () => {
    expect(bootGreeting(128)).toBe('128 notes indexed. System ready.');
  });

  it('greets nobody and addresses nobody', () => {
    const greeting = bootGreeting(5);

    expect(greeting).not.toMatch(/good (morning|afternoon|evening)/i);
    expect(greeting).not.toMatch(/\bsir\b/i);
  });

  it('does not say "1 notes"', () => {
    expect(bootGreeting(1)).toContain('1 note indexed');
  });

  it('says something sensible when the vault is empty', () => {
    const greeting = bootGreeting(0);

    expect(greeting).not.toContain('0 notes');
    expect(greeting).toMatch(/empty/i);
  });
});
