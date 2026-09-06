import { describe, expect, it } from 'vitest';

import { CLUSTER_THRESHOLD, neighboursOf, planFocus } from '../focus.js';
import { buildGalaxy } from '../graph.js';
import type { NoteSource } from '../types.js';

function note(label: string, text: string, group = 'notes'): NoteSource {
  return { key: `${group}/${label}.md`, label, group, text };
}

// Hub links to Spoke One and Spoke Two; Distant stands alone.
const galaxy = buildGalaxy([
  note('Hub', 'Connects [[Spoke One]] and [[Spoke Two]].'),
  note('Spoke One', 'A leaf.'),
  note('Spoke Two', 'Another leaf.'),
  note('Distant', 'Unrelated entirely.'),
  note('Fifth', 'Also unrelated.'),
]);

describe('neighboursOf', () => {
  it('returns everything directly linked, ascending', () => {
    expect(neighboursOf(galaxy, 0)).toEqual([1, 2]);
  });

  it('follows links in both directions', () => {
    expect(neighboursOf(galaxy, 1)).toEqual([0]);
  });

  it('returns nothing for an unconnected node', () => {
    expect(neighboursOf(galaxy, 3)).toEqual([]);
  });
});

describe('planFocus', () => {
  it('stays put when the answer used no notes', () => {
    expect(planFocus(galaxy, [])).toEqual({ mode: 'none' });
  });

  it('flies to the single source and lights its neighbours', () => {
    expect(planFocus(galaxy, [0])).toEqual({ mode: 'single', focus: 0, highlight: [0, 1, 2] });
  });

  it('focuses the top source, not the lowest id', () => {
    const plan = planFocus(galaxy, [2, 0]);
    expect(plan.mode === 'single' && plan.focus).toBe(2);
  });

  it('lights every source as well as the top node neighbours', () => {
    const plan = planFocus(galaxy, [1, 3]);

    expect(plan).toEqual({ mode: 'single', focus: 1, highlight: [0, 1, 3] });
  });

  it('lights the cluster and moves nothing once four notes are involved', () => {
    const plan = planFocus(galaxy, [0, 1, 2, 3]);

    expect(plan).toEqual({ mode: 'cluster', highlight: [0, 1, 2, 3] });
    expect(plan).not.toHaveProperty('focus');
  });

  it('switches to cluster mode exactly at the threshold', () => {
    const below = Array.from({ length: CLUSTER_THRESHOLD - 1 }, (_, i) => i);
    const at = Array.from({ length: CLUSTER_THRESHOLD }, (_, i) => i);

    expect(planFocus(galaxy, below).mode).toBe('single');
    expect(planFocus(galaxy, at).mode).toBe('cluster');
  });

  it('ignores ids that are not real nodes rather than lighting the wrong one', () => {
    expect(planFocus(galaxy, [99, -1, 1.5, 0])).toEqual({
      mode: 'single',
      focus: 0,
      highlight: [0, 1, 2],
    });
  });

  it('does not let duplicates push it into cluster mode', () => {
    expect(planFocus(galaxy, [0, 0, 0, 0, 0]).mode).toBe('single');
  });

  it('returns no plan when every id is unknown', () => {
    expect(planFocus(galaxy, [42, 43])).toEqual({ mode: 'none' });
  });
});
