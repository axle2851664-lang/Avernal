import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CAPABILITIES, capabilityById } from '../capabilities.js';
import { pendingConfirmations, planRequest } from '../planner.js';

describe('capabilities', () => {
  it('only names routes this server actually serves', () => {
    // The guard that stops a plan proposing a step with nothing behind it.
    const server = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'server', 'index.ts'),
      'utf8'
    );
    const missing = CAPABILITIES.filter(
      (c) => c.route !== null && !server.includes(`'${c.route}'`)
    ).map((c) => c.route);
    expect(missing).toEqual([]);
  });

  it('marks everything that reaches outside this machine as needing a yes', () => {
    for (const id of ['mail.sync', 'youtube.sync', 'image.generate', 'video.generate']) {
      expect(capabilityById(id)?.confirm, id).toBe(true);
    }
    for (const id of ['vault.read', 'memory.recall', 'system.health']) {
      expect(capabilityById(id)?.confirm, id).toBe(false);
    }
  });
});

describe('planRequest', () => {
  const projects = [{ id: 'website', name: 'website', memoryCount: 2, updatedAt: '2026-01-01' }];

  it('breaks "help me prepare this project" into steps', () => {
    const plan = planRequest('Help me prepare this project', { projects, currentProjectId: 'website' });

    expect(plan.intent).toBe('prepare a project');
    expect(plan.projectId).toBe('website');
    expect(plan.steps.length).toBeGreaterThan(3);
    expect(plan.unsupported).toBeNull();
  });

  it('resolves the project for "continue the website project"', () => {
    const plan = planRequest('Continue the website project', { projects });
    expect(plan.intent).toBe('continue a project');
    expect(plan.projectId).toBe('website');
  });

  it('says so instead of inventing steps it cannot carry out', () => {
    const plan = planRequest('Book me a flight to Lisbon', { projects });
    expect(plan.steps).toEqual([]);
    expect(plan.unsupported).toContain('cannot break that request down yet');
  });

  it('never marks a step done, because planning runs nothing', () => {
    const plans = [
      planRequest('Help me prepare this project', { projects }),
      planRequest('fetch my unread mail'),
      planRequest('generate an image of a lighthouse'),
    ];
    for (const plan of plans) {
      expect(plan.steps.every((s) => s.status !== 'done')).toBe(true);
    }
  });

  it('holds consequential steps back for confirmation', () => {
    const plan = planRequest('fetch my unread mail');
    const pending = pendingConfirmations(plan);

    expect(pending.map((s) => s.capabilityId)).toContain('mail.sync');
    // The harmless check in the same plan is not held back.
    expect(pending.map((s) => s.capabilityId)).not.toContain('system.health');
  });

  it('plans every step out of a capability that exists', () => {
    const requests = [
      'Help me prepare this project',
      'continue where we left off',
      'remember that the site ships Friday',
      'summarise what I have',
      'what is the status',
      'fetch my unread mail',
      'generate an image of a lighthouse',
    ];

    for (const request of requests) {
      for (const step of planRequest(request, { projects }).steps) {
        if (step.capabilityId === null) continue;
        expect(capabilityById(step.capabilityId), request + ' / ' + step.capabilityId).not.toBeNull();
      }
    }
  });
});
