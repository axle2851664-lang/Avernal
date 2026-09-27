import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildContext, resolveProject } from '../context.js';
import { MemoryStore } from '../store.js';

let root = '';
let store: MemoryStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helix-ctx-'));
  store = new MemoryStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const asked = { origin: 'user-command', detail: 'test' } as const;

function seed(): void {
  store.remember({
    category: 'project',
    projectId: 'website',
    text: 'The website uses the house style guide',
    reason: 'Asked to remember it',
    source: asked,
  });
  store.remember({
    category: 'task',
    projectId: 'website',
    text: 'Write the about page',
    reason: 'Asked to track it',
    source: asked,
  });
  store.remember({
    category: 'project',
    projectId: 'garden',
    text: 'The beds need mulching in spring',
    reason: 'Asked to remember it',
    source: asked,
  });
  store.remember({
    category: 'preference',
    text: 'Keep answers short',
    reason: 'Stated as a preference',
    source: asked,
  });
}

describe('resolveProject', () => {
  it('finds the project a sentence names', () => {
    seed();
    expect(resolveProject('Continue the website project', store.projects())).toBe('website');
    expect(resolveProject('What about the garden?', store.projects())).toBe('garden');
  });

  it('reads a bare "continue" as the project most recently touched', () => {
    seed();
    // This is what makes "continue" mean something rather than nothing.
    const projects = store.projects();
    expect(resolveProject('Continue where we left off', projects)).toBe(projects[0]?.id);
  });

  it('does not invent a project for an unrelated sentence', () => {
    seed();
    expect(resolveProject('What is the weather', store.projects())).toBeNull();
  });

  it('prefers the longer name when one contains the other', () => {
    store.remember({ category: 'project', projectId: 'website', text: 'a', reason: 'r', source: asked });
    store.remember({
      category: 'project',
      projectId: 'website-redesign',
      text: 'b',
      reason: 'r',
      source: asked,
    });
    expect(resolveProject('continue the website redesign', store.projects())).toBe('website-redesign');
  });
});

describe('buildContext', () => {
  it('pulls the right project in for "continue the website project"', () => {
    seed();
    const context = buildContext(store, 'Continue the website project');

    expect(context.projectId).toBe('website');
    const texts = context.items.map((i) => i.memory.text);
    expect(texts).toContain('The website uses the house style guide');
    expect(texts).toContain('Write the about page');
    expect(texts).not.toContain('The beds need mulching in spring');
  });

  it('says why each item was chosen', () => {
    seed();
    const context = buildContext(store, 'Continue the website project');
    const styleGuide = context.items.find((i) => i.memory.text.includes('house style'));
    expect(styleGuide?.because).toContain('belongs to this project');
  });

  it('carries standing preferences into any request', () => {
    seed();
    const context = buildContext(store, 'Generate an image of a lighthouse');
    expect(context.items.map((i) => i.memory.text)).toContain('Keep answers short');
  });

  it('leaves finished tasks out', () => {
    seed();
    const task = store.search({ category: 'task' })[0];
    store.edit(task!.id, { taskState: 'done' });

    const context = buildContext(store, 'Continue the website project');
    expect(context.items.map((i) => i.memory.text)).not.toContain('Write the about page');
  });

  it('keeps one session out of another', () => {
    store.remember({
      category: 'short-term',
      sessionId: 'other',
      text: 'Looking at the garden graph',
      reason: 'Noticed during a session',
      source: { origin: 'observation', detail: 'session' },
    });

    const context = buildContext(store, 'garden graph', { sessionId: 'mine' });
    expect(context.items).toHaveLength(0);
  });

  it('returns nothing rather than everything for an empty store', () => {
    expect(buildContext(store, 'Continue the website project').items).toHaveLength(0);
  });
});
