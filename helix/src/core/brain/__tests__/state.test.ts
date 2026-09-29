import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeState } from '../state.js';
import { planRequest } from '../planner.js';
import { MemoryStore } from '../store.js';

let root = '';
let store: MemoryStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helix-state-'));
  store = new MemoryStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const asked = { origin: 'user-command', detail: 'test' } as const;
const session = { sessionId: 's1', startedAt: '2026-01-01T00:00:00.000Z' };

describe('describeState', () => {
  it('reports an empty brain as empty rather than as unknown', () => {
    const state = describeState(store, { ...session, currentProjectId: null, plan: null });

    expect(state.projects).toEqual([]);
    expect(state.openTasks).toEqual([]);
    expect(state.counts['long-term']).toBe(0);
    // Capabilities are fixed in code, so they are there even with no memory.
    expect(state.capabilities.length).toBeGreaterThan(0);
  });

  it('separates open tasks from finished ones', () => {
    const open = store.remember({
      category: 'task',
      text: 'Write the about page',
      reason: 'Asked to track it',
      source: asked,
    });
    const done = store.remember({
      category: 'task',
      text: 'Buy the domain',
      reason: 'Asked to track it',
      source: asked,
    });
    store.edit(done.id, { taskState: 'done' });

    const state = describeState(store, { ...session, currentProjectId: null, plan: null });
    expect(state.openTasks.map((t) => t.id)).toEqual([open.id]);
  });

  it('holds only the short-term memory of this session', () => {
    store.remember({
      category: 'short-term',
      sessionId: 's1',
      text: 'Mine',
      reason: 'Noticed',
      source: { origin: 'observation', detail: 'session' },
    });
    store.remember({
      category: 'short-term',
      sessionId: 's2',
      text: 'Someone else’s',
      reason: 'Noticed',
      source: { origin: 'observation', detail: 'session' },
    });

    const state = describeState(store, { ...session, currentProjectId: null, plan: null });
    expect(state.shortTerm.map((m) => m.text)).toEqual(['Mine']);
  });

  it('surfaces the steps of a plan that are waiting on a yes', () => {
    const plan = planRequest('fetch my unread mail');
    const state = describeState(store, { ...session, currentProjectId: null, plan });

    expect(state.pendingActions.map((s) => s.capabilityId)).toContain('mail.sync');
    expect(state.pendingActions.every((s) => s.requiresConfirmation)).toBe(true);
  });
});
