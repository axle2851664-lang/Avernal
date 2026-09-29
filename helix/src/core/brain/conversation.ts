/**
 * What was said, kept across restarts.
 *
 * This is a transcript, not a memory. The distinction is the whole reason it
 * is a separate file: a memory is something Helix was asked to keep and can
 * justify keeping, and it has rules about who may write one. A turn is just a
 * record of what passed between you, and it outlives the process because a
 * conversation that forgets itself every time the server restarts is not a
 * conversation.
 *
 * Two rules still apply. Nothing that looks like a credential is written
 * down — the same guard that governs memory, for the same reason. And the log
 * is bounded, because a transcript that grows without limit is a file nobody
 * can open and a context window nobody can afford.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { findSecrets } from './secrets.js';

/** Kept in full. Older turns are dropped, oldest first. */
export const MAX_TURNS = 400;

/** How many turns are replayed to the model by default. */
export const REPLAY_DEPTH = 6;

export interface Turn {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  /** Which run of the server this was said in. */
  readonly sessionId: string;
  readonly at: string;
  /** True when the reply was grounded in notes rather than conversation. */
  readonly grounded: boolean;
}

/** What `record` did, so a caller can say so rather than assume. */
export type Recorded =
  | { readonly kept: true; readonly turn: Turn }
  | { readonly kept: false; readonly reason: string };

interface FileShape {
  readonly version: 1;
  readonly turns: readonly Turn[];
}

const WITHHELD =
  'That exchange was not written down: it contained something that looked like a credential.';

export class ConversationLog {
  readonly #path: string;
  #turns: Turn[] = [];

  public constructor(dataRoot: string) {
    this.#path = join(dataRoot, 'helix-conversation.json');
    this.#load();
  }

  public get path(): string {
    return this.#path;
  }

  #load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as FileShape;
      this.#turns = Array.isArray(parsed.turns) ? [...parsed.turns] : [];
    } catch {
      // A corrupt transcript is kept beside the new one rather than
      // overwritten: it is the only copy of what was said.
      try {
        renameSync(this.#path, this.#path + '.corrupt-' + Date.now());
      } catch {
        /* Best effort. Starting empty is the point. */
      }
      this.#turns = [];
    }
  }

  #save(): void {
    const body: FileShape = { version: 1, turns: this.#turns };
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = this.#path + '.tmp';
    writeFileSync(temporary, JSON.stringify(body, null, 2), 'utf8');
    renameSync(temporary, this.#path);
  }

  /**
   * Write down one exchange.
   *
   * A turn carrying a credential is refused rather than redacted. Redacting
   * means deciding which part was the secret, and being wrong about that
   * writes it down anyway.
   */
  public record(turn: {
    readonly question: string;
    readonly answer: string;
    readonly sessionId: string;
    readonly grounded?: boolean;
  }): Recorded {
    if (findSecrets(turn.question + '\n' + turn.answer).length > 0) {
      return { kept: false, reason: WITHHELD };
    }

    const kept: Turn = {
      id: randomUUID(),
      question: turn.question.trim(),
      answer: turn.answer.trim(),
      sessionId: turn.sessionId,
      at: new Date().toISOString(),
      grounded: turn.grounded ?? false,
    };

    this.#turns.push(kept);
    // Oldest first, so what is dropped is what is least likely to matter.
    if (this.#turns.length > MAX_TURNS) {
      this.#turns = this.#turns.slice(this.#turns.length - MAX_TURNS);
    }
    this.#save();
    return { kept: true, turn: kept };
  }

  /**
   * The last few turns, oldest first, ready to replay to the model.
   *
   * Across every session, not just this one — that is the point of the file.
   */
  public recent(limit: number = REPLAY_DEPTH): readonly Turn[] {
    return this.#turns.slice(Math.max(0, this.#turns.length - limit));
  }

  public all(): readonly Turn[] {
    return this.#turns;
  }

  /** Newest first, filtered by text across both halves of the exchange. */
  public search(text: string, limit = 50): readonly Turn[] {
    const needle = text.trim().toLowerCase();
    const matched =
      needle === ''
        ? this.#turns
        : this.#turns.filter((turn) =>
            (turn.question + ' ' + turn.answer).toLowerCase().includes(needle)
          );
    return [...matched].reverse().slice(0, limit);
  }

  public forget(id: string): boolean {
    const before = this.#turns.length;
    this.#turns = this.#turns.filter((turn) => turn.id !== id);
    if (this.#turns.length === before) return false;
    this.#save();
    return true;
  }

  /** Forget everything ever said. Returns how many turns went. */
  public clear(): number {
    const removed = this.#turns.length;
    if (removed === 0) return 0;
    this.#turns = [];
    this.#save();
    return removed;
  }

  public get size(): number {
    return this.#turns.length;
  }

  /** How many distinct runs of the server are represented. */
  public get sessions(): number {
    return new Set(this.#turns.map((turn) => turn.sessionId)).size;
  }
}
