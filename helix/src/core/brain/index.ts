/**
 * The Helix intelligence layer.
 *
 * Five parts, each usable on its own:
 *
 *   secrets      what must never be written down
 *   rules        what may be remembered, and on whose say-so
 *   store        where memory lives, and the only thing that writes it
 *   context      what already known bears on what was just said
 *   planner      how a request breaks into steps, without running any
 *
 * Nothing here knows about HTTP, and nothing here speaks. The server wires it
 * to routes and the UI renders the state; both can change without this moving.
 */

export type {
  Capability,
  ContextItem,
  ContextResult,
  HelixState,
  Memory,
  MemoryCategory,
  MemoryDraft,
  MemoryOrigin,
  MemoryPatch,
  MemoryQuery,
  MemorySource,
  Plan,
  PlanStep,
  PlanStepStatus,
  Project,
  TaskState,
} from './types.js';
export { MEMORY_CATEGORIES } from './types.js';

export { containsSecret, findSecrets, refusalFor } from './secrets.js';
export type { SecretFinding } from './secrets.js';

export { assess, sameMemory, MAX_REASON_LENGTH, MAX_TEXT_LENGTH } from './rules.js';
export type { Admission } from './rules.js';

export { MemoryRefused, MemoryStore } from './store.js';

export { ConversationLog, MAX_TURNS, REPLAY_DEPTH } from './conversation.js';
export type { Recorded, Turn } from './conversation.js';

export { capturesFrom } from './listen.js';
export type { Capture } from './listen.js';

export { buildContext, resolveProject } from './context.js';
export type { ContextOptions } from './context.js';

export { CAPABILITIES, capabilityById, capabilityIds } from './capabilities.js';

export { pendingConfirmations, planRequest } from './planner.js';
export type { PlanOptions } from './planner.js';

export { describeState } from './state.js';
export type { SessionInfo } from './state.js';
