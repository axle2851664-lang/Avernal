/**
 * Where memories live.
 *
 * One JSON file under the data root, held in memory and written out after
 * every change. That is the right shape for this: the whole point of Helix's
 * data root is that it can live on a USB drive, and a file you can open in a
 * text editor is one you can audit, back up and delete without needing Helix
 * to cooperate.
 *
 * The store enforces the admission rules on the way in. Nothing writes to the
 * file except through here.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  Memory,
  MemoryCategory,
  MemoryDraft,
  MemoryPatch,
  MemoryQuery,
  Project,
} from './types.js';
import { MEMORY_CATEGORIES } from './types.js';
import { assess, sameMemory } from './rules.js';
import { findSecrets, refusalFor } from './secrets.js';

export class MemoryRefused extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MemoryRefused';
  }
}

interface FileShape {
  readonly version: 1;
  readonly memories: readonly Memory[];
}

const FILE_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

export class MemoryStore {
  readonly #path: string;
  #memories: Memory[] = [];

  public constructor(dataRoot: string) {
    this.#path = join(dataRoot, 'helix-memory.json');
    this.#load();
  }

  /** Where the file is, so the user can be told where their memory lives. */
  public get path(): string {
    return this.#path;
  }

  #load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch (error) {
      // No file yet is the normal state before the first memory.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as FileShape;
      this.#memories = Array.isArray(parsed.memories) ? [...parsed.memories] : [];
    } catch {
      // A corrupt file is not a reason to crash on boot, but it is also not
      // something to overwrite silently: the bad file is kept beside the new
      // one so nothing is lost.
      try {
        renameSync(this.#path, this.#path + '.corrupt-' + Date.now());
      } catch {
        /* Keeping the copy is best effort; starting empty is the point. */
      }
      this.#memories = [];
    }
  }

  #save(): void {
    const body: FileShape = { version: FILE_VERSION, memories: this.#memories };
    mkdirSync(dirname(this.#path), { recursive: true });
    // Write beside and rename: a crash mid-write leaves the old file intact
    // rather than a truncated one.
    const temporary = this.#path + '.tmp';
    writeFileSync(temporary, JSON.stringify(body, null, 2), 'utf8');
    renameSync(temporary, this.#path);
  }

  /* ------------------------------------------------------------- writing */

  /**
   * Remember something, if the rules allow it.
   *
   * Throws rather than returning a flag, because every caller has to deal with
   * a refusal and a thrown refusal cannot be ignored by accident.
   */
  public remember(draft: MemoryDraft): Memory {
    const verdict = assess(draft);
    if (!verdict.admit) throw new MemoryRefused(verdict.refusal);

    const existing = this.#memories.find(
      (m) =>
        m.category === draft.category &&
        m.projectId === (draft.projectId ?? null) &&
        sameMemory(m.text, draft.text)
    );
    if (existing !== undefined) {
      // Saying the same thing again is not a new memory. Touch the one that is
      // already there so its recency reflects that it came up.
      return this.#replace(existing.id, { ...existing, updatedAt: nowIso() });
    }

    const memory: Memory = {
      id: randomUUID(),
      category: draft.category,
      text: draft.text.trim(),
      reason: verdict.reason,
      source: draft.source,
      projectId: draft.projectId ?? null,
      taskState: draft.taskState ?? (draft.category === 'task' ? 'open' : null),
      sessionId: draft.sessionId ?? null,
      tags: draft.tags ?? [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    this.#memories.push(memory);
    this.#save();
    return memory;
  }

  #replace(id: string, next: Memory): Memory {
    const index = this.#memories.findIndex((m) => m.id === id);
    if (index === -1) throw new MemoryRefused('No memory with that id.');
    this.#memories[index] = next;
    this.#save();
    return next;
  }

  /** Change an existing memory. The same rules apply as on the way in. */
  public edit(id: string, patch: MemoryPatch): Memory {
    const current = this.#memories.find((m) => m.id === id);
    if (current === undefined) throw new MemoryRefused('No memory with that id.');

    const text = patch.text ?? current.text;
    const reason = patch.reason ?? current.reason;

    const secrets = findSecrets(text + '\n' + reason);
    if (secrets.length > 0) throw new MemoryRefused(refusalFor(secrets));

    if (text.trim() === '') throw new MemoryRefused('A memory cannot be emptied. Delete it instead.');
    if (reason.trim() === '') throw new MemoryRefused('A memory cannot lose its reason.');

    const category = patch.category ?? current.category;
    if (category === 'project' && (patch.projectId ?? current.projectId ?? '') === '') {
      throw new MemoryRefused('Project memory has to name the project it belongs to.');
    }

    return this.#replace(id, {
      ...current,
      text: text.trim(),
      reason: reason.trim(),
      category,
      projectId: patch.projectId === undefined ? current.projectId : patch.projectId,
      taskState: patch.taskState === undefined ? current.taskState : patch.taskState,
      tags: patch.tags ?? current.tags,
      updatedAt: nowIso(),
    });
  }

  /** Remove one memory. Returns false if it was not there to begin with. */
  public forget(id: string): boolean {
    const before = this.#memories.length;
    this.#memories = this.#memories.filter((m) => m.id !== id);
    if (this.#memories.length === before) return false;
    this.#save();
    return true;
  }

  /**
   * Remove a whole category, or everything.
   *
   * Returns how many went, so the user is told what actually happened rather
   * than just that something did.
   */
  public clear(category?: MemoryCategory): number {
    const before = this.#memories.length;
    this.#memories =
      category === undefined ? [] : this.#memories.filter((m) => m.category !== category);
    const removed = before - this.#memories.length;
    if (removed > 0) this.#save();
    return removed;
  }

  /** Drop a session's short-term memory. Called when a session ends. */
  public endSession(sessionId: string): number {
    const before = this.#memories.length;
    this.#memories = this.#memories.filter(
      (m) => !(m.category === 'short-term' && m.sessionId === sessionId)
    );
    const removed = before - this.#memories.length;
    if (removed > 0) this.#save();
    return removed;
  }

  /* ------------------------------------------------------------- reading */

  public get(id: string): Memory | null {
    return this.#memories.find((m) => m.id === id) ?? null;
  }

  public all(): readonly Memory[] {
    return this.#memories;
  }

  /** Newest first, filtered by whatever the query names. */
  public search(query: MemoryQuery = {}): readonly Memory[] {
    const needle = (query.text ?? '').trim().toLowerCase();

    const matched = this.#memories.filter((m) => {
      if (query.category !== undefined && m.category !== query.category) return false;
      if (query.projectId !== undefined && m.projectId !== query.projectId) return false;
      if (query.sessionId !== undefined && m.sessionId !== query.sessionId) return false;
      if (needle !== '') {
        const haystack = (m.text + ' ' + m.reason + ' ' + m.tags.join(' ')).toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    const sorted = [...matched].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return query.limit === undefined ? sorted : sorted.slice(0, query.limit);
  }

  public counts(): Record<MemoryCategory, number> {
    const tally = {} as Record<MemoryCategory, number>;
    for (const category of MEMORY_CATEGORIES) tally[category] = 0;
    for (const memory of this.#memories) tally[memory.category] += 1;
    return tally;
  }

  /** Every project that project memory names, most recently touched first. */
  public projects(): readonly Project[] {
    const byId = new Map<string, { count: number; updatedAt: string }>();

    for (const memory of this.#memories) {
      if (memory.projectId === null) continue;
      const seen = byId.get(memory.projectId);
      if (seen === undefined) {
        byId.set(memory.projectId, { count: 1, updatedAt: memory.updatedAt });
        continue;
      }
      seen.count += 1;
      if (memory.updatedAt > seen.updatedAt) seen.updatedAt = memory.updatedAt;
    }

    return [...byId.entries()]
      .map(([id, seen]) => ({
        id,
        // The id is the name, slugged. Projects are named by the user, so this
        // reads it back rather than storing a second copy that can drift.
        name: id.replace(/[-_]+/g, ' ').trim(),
        memoryCount: seen.count,
        updatedAt: seen.updatedAt,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
}
