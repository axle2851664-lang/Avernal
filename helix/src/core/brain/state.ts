/**
 * The single structured answer to "what is Helix holding right now".
 *
 * Assembled on demand from the store rather than kept as a second copy that
 * can drift. The UI renders this; nothing has to reach into the store itself.
 */

import { CAPABILITIES } from './capabilities.js';
import { pendingConfirmations } from './planner.js';
import type { MemoryStore } from './store.js';
import type { HelixState, Plan, PlanStep, Project } from './types.js';

export interface SessionInfo {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly currentProjectId: string | null;
  /** The plan in hand, if a request has been planned and not finished. */
  readonly plan: Plan | null;
}

const RECENT_SHORT_TERM = 12;

export function describeState(store: MemoryStore, session: SessionInfo): HelixState {
  const projects = store.projects();
  const current: Project | null =
    session.currentProjectId === null
      ? null
      : projects.find((p) => p.id === session.currentProjectId) ?? null;

  const openTasks = store
    .search({ category: 'task' })
    .filter((m) => m.taskState === 'open' || m.taskState === 'blocked');

  const pending: readonly PlanStep[] =
    session.plan === null ? [] : pendingConfirmations(session.plan);

  return {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    currentProject: current,
    openTasks,
    shortTerm: store.search({ category: 'short-term', sessionId: session.sessionId, limit: RECENT_SHORT_TERM }),
    preferences: store.search({ category: 'preference' }),
    projects,
    capabilities: CAPABILITIES,
    pendingActions: pending,
    counts: store.counts(),
  };
}
