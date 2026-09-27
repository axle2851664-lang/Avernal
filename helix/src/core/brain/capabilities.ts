/**
 * Everything Helix can actually do, and which of it needs asking first.
 *
 * Every entry names a route this server really serves. That is the whole point
 * of keeping the list here rather than letting the planner name actions
 * freely: a plan can only ever be built out of these, so it cannot propose a
 * step with nothing behind it. A test checks each route against the server.
 *
 * `confirm` marks the steps with consequences beyond this machine — reaching
 * out to an account, or spending minutes of compute. Planning one is fine;
 * running it is the user's call.
 */

import type { Capability } from './types.js';

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'vault.read',
    summary: 'Read the note graph — titles, folders and links',
    route: '/galaxy',
    confirm: false,
  },
  {
    id: 'vault.capture',
    summary: 'Write a note into the vault',
    route: '/notes',
    confirm: false,
  },
  {
    id: 'system.health',
    summary: 'Check which subsystems are connected',
    route: '/health',
    confirm: false,
  },
  {
    id: 'mail.sync',
    summary: 'Fetch unread mail from Gmail',
    route: '/sync/gmail/unread',
    confirm: true,
  },
  {
    id: 'youtube.sync',
    summary: 'Fetch recent videos from YouTube',
    route: '/sync/youtube/videos',
    confirm: true,
  },
  {
    id: 'image.generate',
    summary: 'Generate an image from a prompt',
    route: '/generate/image',
    confirm: true,
  },
  {
    id: 'video.generate',
    summary: 'Generate a short video from a prompt',
    route: '/generate/video',
    confirm: true,
  },
  {
    id: 'memory.recall',
    summary: 'Look through what Helix remembers',
    route: null,
    confirm: false,
  },
  {
    id: 'memory.write',
    summary: 'Remember something the user asked to keep',
    route: null,
    confirm: false,
  },
];

export function capabilityById(id: string): Capability | null {
  return CAPABILITIES.find((c) => c.id === id) ?? null;
}

/** Ids only, for anywhere that just needs to know what exists. */
export function capabilityIds(): readonly string[] {
  return CAPABILITIES.map((c) => c.id);
}
