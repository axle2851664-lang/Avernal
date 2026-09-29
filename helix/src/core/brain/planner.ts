/**
 * Turns a request into a plan, and stops there.
 *
 * What this is: a rule-based decomposition of the requests Helix can recognise
 * into steps built from real capabilities. What it is not: an understander of
 * arbitrary language. When it does not recognise a request it says so and
 * returns no steps, because a plan nobody can carry out is worse than an
 * admission — and inventing steps to look capable is exactly the fake
 * intelligence this must not grow.
 *
 * Nothing here runs anything. Producing a plan has no side effects at all;
 * steps that would reach outside this machine come back marked as awaiting
 * confirmation, and something else has to decide to execute them.
 */

import { capabilityById } from './capabilities.js';
import { resolveProject } from './context.js';
import type { Plan, PlanStep, Project } from './types.js';

/** A step that is Helix thinking, not Helix doing. */
function think(summary: string): PlanStep {
  return { summary, capabilityId: null, requiresConfirmation: false, status: 'planned' };
}

/** A step that uses a capability. Confirmation comes from the registry. */
function act(capabilityId: string, summary: string): PlanStep {
  const capability = capabilityById(capabilityId);
  if (capability === null) {
    // Unreachable through the intents below, and a hard failure rather than a
    // silent one if a future intent names something that does not exist.
    throw new Error('Unknown capability in a plan: ' + capabilityId);
  }
  return {
    summary,
    capabilityId,
    requiresConfirmation: capability.confirm,
    status: capability.confirm ? 'awaiting-confirmation' : 'planned',
  };
}

interface Intent {
  readonly name: string;
  readonly test: RegExp;
  readonly build: (request: string, projectId: string | null) => readonly PlanStep[];
}

/**
 * The requests Helix can decompose today.
 *
 * Kept small and explicit. Each one is a shape a person actually says, mapped
 * to steps that exist; adding an intent is adding a row here, which is the
 * modularity this layer is for.
 */
const INTENTS: readonly Intent[] = [
  {
    name: 'prepare a project',
    test: /\b(?:prepare|set up|get .* ready|organi[sz]e|plan)\b.*\bproject\b|\bproject\b.*\b(?:prepare|ready|organi[sz]e)\b/i,
    build: (_request, projectId) => [
      think(
        projectId === null
          ? 'Work out which project this is — none was named and none is current'
          : 'Recall what is already known about this project'
      ),
      act('memory.recall', 'Gather the project memory and any open tasks'),
      act('vault.read', 'Look for notes in the vault that belong to this project'),
      think('List what is missing and what is already done'),
      think('Propose the order of work, and say which steps need permission'),
    ],
  },
  {
    name: 'continue a project',
    test: /\b(?:continue|carry on|resume|pick up|back to|keep going on)\b/i,
    build: (_request, projectId) => [
      think(
        projectId === null
          ? 'No project is current, so ask which one is meant'
          : 'Recall where this project was left'
      ),
      act('memory.recall', 'Read the project memory and its open tasks'),
      think('Report the next unfinished step'),
    ],
  },
  {
    name: 'capture a note',
    test: /\b(?:remember|note down|write down|capture|save this|make a note)\b/i,
    build: () => [
      think('Decide whether this belongs in memory or in the vault as a note'),
      act('memory.write', 'Keep it as a memory, with the reason recorded'),
      act('vault.capture', 'Or write it into the vault if it is a note, not a fact'),
    ],
  },
  {
    name: 'review the vault',
    test: /\b(?:what do (?:i|you) (?:have|know)|summari[sz]e|review|overview|analy[sz]e)\b/i,
    build: () => [
      act('vault.read', 'Read the note graph'),
      act('memory.recall', 'Read what is already remembered'),
      think('Report the shape of it: counts, clusters, and what is unlinked'),
    ],
  },
  {
    name: 'check on the system',
    test: /\b(?:status|health|what.s connected|are you (?:connected|online)|subsystems)\b/i,
    build: () => [
      act('system.health', 'Ask the server which subsystems are connected'),
      think('Report each one, and say plainly which are not connected'),
    ],
  },
  {
    name: 'bring in mail',
    test: /\b(?:unread|mail|inbox|email)\b/i,
    build: () => [
      act('system.health', 'Check that Gmail is connected before trying'),
      act('mail.sync', 'Fetch unread mail'),
      think('Summarise what came back'),
    ],
  },
  {
    name: 'generate an image',
    test: /\b(?:generate|make|create|draw|render)\b.*\b(?:image|picture|art|illustration|video)\b/i,
    build: () => [
      think('Settle the prompt, and the type — image or video'),
      act('image.generate', 'Generate it, once the user has approved the prompt'),
      think('Show the result and where the file was written'),
    ],
  },
];

export interface PlanOptions {
  readonly projects?: readonly Project[];
  readonly currentProjectId?: string | null;
}

/**
 * Plan a request.
 *
 * Intents are tried in order and the first match wins, so the more specific
 * shapes are listed before the looser ones.
 */
export function planRequest(request: string, options: PlanOptions = {}): Plan {
  const projects = options.projects ?? [];
  const projectId = resolveProject(request, projects, options.currentProjectId ?? null);

  if (request.trim() === '') {
    return {
      request,
      intent: null,
      projectId: null,
      steps: [],
      unsupported: 'There is no request to plan.',
    };
  }

  for (const intent of INTENTS) {
    if (!intent.test.test(request)) continue;
    return {
      request,
      intent: intent.name,
      projectId,
      steps: intent.build(request, projectId),
      unsupported: null,
    };
  }

  return {
    request,
    intent: null,
    projectId,
    steps: [],
    unsupported:
      'Helix cannot break that request down yet. It plans: ' +
      INTENTS.map((i) => i.name).join(', ') +
      '.',
  };
}

/** The steps in a plan that nobody may run without being asked. */
export function pendingConfirmations(plan: Plan): readonly PlanStep[] {
  return plan.steps.filter((step) => step.requiresConfirmation && step.status !== 'done');
}
