/**
 * Turns the notes an answer used into what the view should do about it.
 *
 * This is the "prove it" step: the answer names its sources, and the galaxy
 * shows them. Deciding *what* to light up is pure; flying the camera and
 * animating the glow belong to the view.
 */

import type { Galaxy } from './types.js';

/**
 * At this many sources, flying to one node misrepresents the answer — it came
 * from a cluster, so the cluster is what gets shown.
 */
export const CLUSTER_THRESHOLD = 4;

export type FocusPlan =
  /** Nothing was drawn from the notes: small talk, a joke, an admitted gap. */
  | { readonly mode: 'none' }
  /** One clear source: fly to it, light it and its direct neighbours. */
  | { readonly mode: 'single'; readonly focus: number; readonly highlight: readonly number[] }
  /** Several sources: light the cluster where it stands, move nothing. */
  | { readonly mode: 'cluster'; readonly highlight: readonly number[] };

/** Ids directly linked to `id`, ascending. */
export function neighboursOf(galaxy: Galaxy, id: number): number[] {
  const found = new Set<number>();

  for (const link of galaxy.links) {
    if (link.source === id) found.add(link.target);
    else if (link.target === id) found.add(link.source);
  }

  return [...found].sort((a, b) => a - b);
}

/**
 * Decides how to show an answer's sources.
 *
 * `sources` is the `nodes` array an answer came back with, best first. Unknown
 * and duplicate ids are dropped rather than trusted, since acting on a stale id
 * would light the wrong note and quietly tell the user a lie about provenance.
 *
 * An empty result is meaningful: it is what keeps the camera still during small
 * talk instead of hunting for something to point at.
 */
export function planFocus(galaxy: Galaxy, sources: readonly number[]): FocusPlan {
  const valid: number[] = [];
  const seen = new Set<number>();

  for (const id of sources) {
    if (!Number.isInteger(id) || id < 0 || id >= galaxy.nodes.length || seen.has(id)) continue;
    seen.add(id);
    valid.push(id);
  }

  const top = valid[0];
  if (top === undefined) return { mode: 'none' };

  if (valid.length >= CLUSTER_THRESHOLD) {
    return { mode: 'cluster', highlight: [...valid].sort((a, b) => a - b) };
  }

  // Every source is lit — they are all evidence — plus the top node's
  // neighbours, which show where it sits rather than leaving it floating alone.
  const highlight = new Set<number>(valid);
  for (const neighbour of neighboursOf(galaxy, top)) highlight.add(neighbour);

  return { mode: 'single', focus: top, highlight: [...highlight].sort((a, b) => a - b) };
}
