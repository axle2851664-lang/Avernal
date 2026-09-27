import { describe, expect, it } from 'vitest';
import { assess, MAX_TEXT_LENGTH, sameMemory } from '../rules.js';
import type { MemoryDraft } from '../types.js';

function draft(over: Partial<MemoryDraft> = {}): MemoryDraft {
  return {
    category: 'long-term',
    text: 'The website project uses the house style guide',
    reason: 'Asked to remember it',
    source: { origin: 'user-command', detail: 'remember that…' },
    ...over,
  };
}

describe('assess', () => {
  it('admits something the user asked to keep', () => {
    expect(assess(draft()).admit).toBe(true);
  });

  it('will not keep an observation past the session', () => {
    // The rule that stops Helix quietly accumulating a profile of someone.
    for (const category of ['long-term', 'preference', 'project', 'task'] as const) {
      const verdict = assess(
        draft({ category, projectId: 'website', source: { origin: 'observation', detail: 'noticed' } })
      );
      expect(verdict.admit, category).toBe(false);
    }
  });

  it('does let an observation into short-term memory', () => {
    const verdict = assess(
      draft({
        category: 'short-term',
        sessionId: 's1',
        source: { origin: 'observation', detail: 'noticed' },
      })
    );
    expect(verdict.admit).toBe(true);
  });

  it('refuses a memory with no reason', () => {
    expect(assess(draft({ reason: '  ' })).admit).toBe(false);
  });

  it('refuses credentials in either the text or the reason', () => {
    expect(assess(draft({ text: 'my password is hunter2xyz' })).admit).toBe(false);
    expect(assess(draft({ reason: 'so I remember ' + 'sk' + '-abcdefghijklmnopqrstuvwxyz123456' })).admit).toBe(false);
  });

  it('refuses something too long to be one memory', () => {
    expect(assess(draft({ text: 'x'.repeat(MAX_TEXT_LENGTH + 1) })).admit).toBe(false);
  });

  it('makes project memory name its project and short-term name its session', () => {
    expect(assess(draft({ category: 'project' })).admit).toBe(false);
    expect(assess(draft({ category: 'project', projectId: 'website' })).admit).toBe(true);
    expect(assess(draft({ category: 'short-term' })).admit).toBe(false);
  });
});

describe('sameMemory', () => {
  it('ignores case, spacing and punctuation', () => {
    expect(sameMemory('Ship the site on Friday', 'ship the site on friday.')).toBe(true);
    expect(sameMemory('Ship the site on Friday', 'Ship the site on Monday')).toBe(false);
  });
});
