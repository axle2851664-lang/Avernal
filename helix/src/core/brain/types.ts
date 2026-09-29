/**
 * The Helix intelligence layer's data model.
 *
 * Deliberately free of any transport or storage concern: these types describe
 * what Helix knows, not where it is kept or how it is served. Everything
 * downstream — the store, the context engine, the planner, the HTTP routes —
 * is built on these and can be replaced without touching them.
 */

/**
 * The five kinds of memory, kept apart because they have different lifetimes
 * and different rules about what is allowed in.
 *
 *   short-term  the current session only, dropped when it ends
 *   long-term   kept until the user removes it, and only saved on request
 *   project     tied to one named body of work
 *   task        something to do, and what has been done toward it
 *   preference  how the user wants Helix to behave
 */
export type MemoryCategory = 'short-term' | 'long-term' | 'project' | 'task' | 'preference';

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'short-term',
  'long-term',
  'project',
  'task',
  'preference',
];

/**
 * Where a memory came from.
 *
 * This is what makes "why do you know that?" answerable, and the distinction
 * is load-bearing rather than descriptive — the admission rules read it.
 *
 *   user-command  the user asked for this to be kept, in so many words
 *   stated        the user said it as a preference; Helix matched the phrase,
 *                 it did not infer the preference
 *   observation   Helix noticed it. Short-term memory only.
 *
 * `stated` is the narrow middle. It exists so "I prefer short answers" can be
 * kept without opening the door to Helix deciding on its own what kind of
 * person you are. Nothing produces it except an explicit turn of phrase, and
 * every one is reported back when it happens.
 */
export type MemoryOrigin = 'user-command' | 'stated' | 'observation' | 'vault' | 'import';

export interface MemorySource {
  readonly origin: MemoryOrigin;
  /** Free text naming the specific thing: a note key, an endpoint, a phrase. */
  readonly detail: string;
}

export type TaskState = 'open' | 'blocked' | 'done' | 'abandoned';

export interface Memory {
  readonly id: string;
  readonly category: MemoryCategory;
  /** The content itself, as the user would read it back. */
  readonly text: string;
  /**
   * Why this is being kept, in a sentence. Required, not optional: a memory
   * nobody can justify is a memory nobody can audit.
   */
  readonly reason: string;
  readonly source: MemorySource;
  /** Set for project memory, and for anything else scoped to a project. */
  readonly projectId: string | null;
  /** Set for task memory. Meaningless elsewhere. */
  readonly taskState: TaskState | null;
  /** Short-term memory belongs to exactly one session. */
  readonly sessionId: string | null;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a caller supplies to remember something. Ids and stamps are the store's. */
export interface MemoryDraft {
  readonly category: MemoryCategory;
  readonly text: string;
  readonly reason: string;
  readonly source: MemorySource;
  readonly projectId?: string | null;
  readonly taskState?: TaskState | null;
  readonly sessionId?: string | null;
  readonly tags?: readonly string[];
}

/** Fields a caller may change on an existing memory. */
export interface MemoryPatch {
  readonly text?: string;
  readonly reason?: string;
  readonly category?: MemoryCategory;
  readonly projectId?: string | null;
  readonly taskState?: TaskState | null;
  readonly tags?: readonly string[];
}

export interface MemoryQuery {
  readonly category?: MemoryCategory;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly text?: string;
  readonly limit?: number;
}

/**
 * A named body of work. Projects are memories too — this is the view of one,
 * assembled from the project memory that names it.
 */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly memoryCount: number;
  readonly updatedAt: string;
}

/**
 * Something Helix can actually do.
 *
 * The list is fixed in code and every entry names a real endpoint, so a plan
 * can never propose a step that has nothing behind it. `confirm` marks the
 * ones with consequences outside this machine.
 */
export interface Capability {
  readonly id: string;
  readonly summary: string;
  /** The server route this runs through, or null for a purely local step. */
  readonly route: string | null;
  /** True when running it needs the user to say yes first. */
  readonly confirm: boolean;
}

export type PlanStepStatus = 'planned' | 'awaiting-confirmation' | 'done' | 'skipped';

export interface PlanStep {
  readonly summary: string;
  /** The capability this step would use, or null when it is thinking, not doing. */
  readonly capabilityId: string | null;
  readonly requiresConfirmation: boolean;
  readonly status: PlanStepStatus;
}

export interface Plan {
  readonly request: string;
  /** What Helix understood the request to be about, or null if it did not. */
  readonly intent: string | null;
  readonly projectId: string | null;
  readonly steps: readonly PlanStep[];
  /**
   * Set when Helix cannot plan the request. Populated instead of inventing
   * steps: a plan that cannot be carried out is worse than saying so.
   */
  readonly unsupported: string | null;
}

/** What the context engine decided was relevant, and why. */
export interface ContextItem {
  readonly memory: Memory;
  readonly score: number;
  /** Which part of the request or state pulled this in. */
  readonly because: string;
}

export interface ContextResult {
  readonly utterance: string;
  readonly projectId: string | null;
  readonly items: readonly ContextItem[];
  /** Terms the engine matched on, so a poor result is diagnosable. */
  readonly terms: readonly string[];
}

/** The whole of what Helix currently holds, for the UI to render. */
export interface HelixState {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly currentProject: Project | null;
  readonly openTasks: readonly Memory[];
  readonly shortTerm: readonly Memory[];
  readonly preferences: readonly Memory[];
  readonly projects: readonly Project[];
  readonly capabilities: readonly Capability[];
  readonly pendingActions: readonly PlanStep[];
  /** How much has been said, across every run of the server. */
  readonly conversation: { readonly turns: number; readonly sessions: number };
  readonly counts: Readonly<Record<MemoryCategory, number>>;
}
