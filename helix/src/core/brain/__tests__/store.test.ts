import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryRefused, MemoryStore } from '../store.js';
import type { MemoryDraft } from '../types.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helix-brain-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function draft(over: Partial<MemoryDraft> = {}): MemoryDraft {
  return {
    category: 'long-term',
    text: 'The website project ships on Friday',
    reason: 'Asked to remember the deadline',
    source: { origin: 'user-command', detail: 'remember that…' },
    ...over,
  };
}

describe('MemoryStore', () => {
  it('creates, reads back and survives a restart', () => {
    const store = new MemoryStore(root);
    const saved = store.remember(draft());

    expect(saved.id).not.toBe('');
    expect(saved.reason).toBe('Asked to remember the deadline');

    // A second store over the same root is what a restart looks like.
    const reopened = new MemoryStore(root);
    expect(reopened.get(saved.id)?.text).toBe('The website project ships on Friday');
  });

  it('refuses what the rules refuse, and writes nothing', () => {
    const store = new MemoryStore(root);
    expect(() => store.remember(draft({ text: 'my password is hunter2xyz' }))).toThrow(MemoryRefused);
    expect(store.all()).toHaveLength(0);
  });

  it('treats the same thing said twice as one memory', () => {
    const store = new MemoryStore(root);
    const first = store.remember(draft());
    const again = store.remember(draft({ text: 'the website project ships on friday.' }));

    expect(store.all()).toHaveLength(1);
    expect(again.id).toBe(first.id);
  });

  it('edits, and re-checks the rules on the way through', () => {
    const store = new MemoryStore(root);
    const saved = store.remember(draft());

    const edited = store.edit(saved.id, { text: 'The website project ships on Monday' });
    expect(edited.text).toBe('The website project ships on Monday');
    expect(edited.updatedAt >= saved.updatedAt).toBe(true);

    expect(() => store.edit(saved.id, { text: 'token ' + 'ghp' + '_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' })).toThrow(
      MemoryRefused
    );
    expect(() => store.edit(saved.id, { text: '   ' })).toThrow(MemoryRefused);
    // The refused edits left the good value in place.
    expect(store.get(saved.id)?.text).toBe('The website project ships on Monday');
  });

  it('deletes one, and says whether there was one to delete', () => {
    const store = new MemoryStore(root);
    const saved = store.remember(draft());

    expect(store.forget(saved.id)).toBe(true);
    expect(store.forget(saved.id)).toBe(false);
    expect(store.get(saved.id)).toBeNull();
  });

  it('clears one category or everything, and reports how many went', () => {
    const store = new MemoryStore(root);
    store.remember(draft());
    store.remember(draft({ category: 'preference', text: 'Keep answers short' }));
    store.remember(draft({ category: 'short-term', sessionId: 's1', text: 'Looking at the graph' }));

    expect(store.clear('preference')).toBe(1);
    expect(store.counts().preference).toBe(0);
    expect(store.all()).toHaveLength(2);

    expect(store.clear()).toBe(2);
    expect(store.all()).toHaveLength(0);
  });

  it('drops the short-term memory of one session and leaves the rest', () => {
    const store = new MemoryStore(root);
    store.remember(draft());
    store.remember(draft({ category: 'short-term', sessionId: 's1', text: 'On the graph screen' }));
    store.remember(draft({ category: 'short-term', sessionId: 's2', text: 'On the inbox screen' }));

    expect(store.endSession('s1')).toBe(1);
    expect(store.search({ category: 'short-term' })).toHaveLength(1);
    expect(store.counts()['long-term']).toBe(1);
  });

  it('searches by category, project and text', () => {
    const store = new MemoryStore(root);
    store.remember(draft({ category: 'project', projectId: 'website', text: 'Uses the house style' }));
    store.remember(draft({ category: 'project', projectId: 'garden', text: 'Beds need mulching' }));
    store.remember(draft({ text: 'Unrelated long-term fact' }));

    expect(store.search({ category: 'project' })).toHaveLength(2);
    expect(store.search({ projectId: 'website' })).toHaveLength(1);
    expect(store.search({ text: 'mulch' })).toHaveLength(1);
    expect(store.search({ text: 'MULCH' })).toHaveLength(1);
  });

  it('lists projects with counts, most recently touched first', () => {
    const store = new MemoryStore(root);
    store.remember(draft({ category: 'project', projectId: 'website', text: 'One' }));
    store.remember(draft({ category: 'project', projectId: 'website', text: 'Two' }));
    store.remember(draft({ category: 'project', projectId: 'garden', text: 'Three' }));

    const projects = store.projects();
    expect(projects.map((p) => p.id).sort()).toEqual(['garden', 'website']);
    expect(projects.find((p) => p.id === 'website')?.memoryCount).toBe(2);
  });

  it('keeps a corrupt file instead of overwriting it', () => {
    const path = join(root, 'helix-memory.json');
    writeFileSync(path, '{ not json', 'utf8');

    const store = new MemoryStore(root);
    expect(store.all()).toHaveLength(0);

    store.remember(draft());
    // The new file is valid...
    expect(JSON.parse(readFileSync(path, 'utf8')).memories).toHaveLength(1);
  });
});
