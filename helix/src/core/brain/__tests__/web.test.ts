import { describe, expect, it } from 'vitest';

import { WEB_ADDENDUM, webTriggerFor } from '../web.js';

describe('webTriggerFor', () => {
  it('turns on when the user says so', () => {
    for (const said of [
      'search the web for the tallest bridge',
      'look it up',
      'can you look that up',
      'google the release date',
      'check the internet',
      'what does it say on the web',
      'do a web search for helix',
    ]) {
      expect(webTriggerFor(said), said).not.toBeNull();
      expect(webTriggerFor(said)?.kind, said).toBe('asked');
    }
  });

  it('turns on for things a personal vault cannot contain', () => {
    for (const said of [
      "what's the latest version of node",
      'what is the current price of silver',
      'who won the match',
      "what's the weather",
      'what happened today',
      'how much does a licence cost',
    ]) {
      expect(webTriggerFor(said), said).not.toBeNull();
      expect(webTriggerFor(said)?.kind, said).toBe('current');
    }
  });

  it('stays off for the questions the vault is for', () => {
    // The default has to be the vault. Every false positive here is a billed
    // search and an answer built on a stranger's page instead of the user's
    // own notes.
    for (const said of [
      'what is my storage ceiling',
      'what did I write about the relay',
      'remember this: I take my answers short',
      'summarise the planner notes',
      'what do you think of it',
      'who is on the list',
      'what is in the vault',
    ]) {
      expect(webTriggerFor(said), said).toBeNull();
    }
  });

  it('can be told not to', () => {
    // Without an off switch there is no way to ask about "the latest note I
    // wrote today" and stay off the web.
    expect(webTriggerFor("what's the latest, don't search")).toBeNull();
    expect(webTriggerFor('what did I do today without searching')).toBeNull();
    // The verb takes any ending — the first version of this matched
    // "without search" and not "without searching".
    expect(webTriggerFor("what's the weather, without using the web")).toBeNull();
    expect(webTriggerFor('the current plan, no need to look it up')).toBeNull();
  });

  it('names the phrase that turned it on', () => {
    // A search nobody expected is worse than no search. The reply can say
    // which words did it, which is what makes this predictable.
    expect(webTriggerFor('look it up')?.phrase).toBe('look it up');
    expect(webTriggerFor("what's the weather")?.phrase).toBe('weather');
  });

  it('ignores an empty question', () => {
    expect(webTriggerFor('')).toBeNull();
    expect(webTriggerFor('   ')).toBeNull();
  });
});

describe('WEB_ADDENDUM', () => {
  it('lifts the notes-only rule for search results and nothing else', () => {
    // The persona forbids any fact that is not in the notes. Without this
    // exception a search result cannot be used; stated too broadly, the rule
    // against inventing facts stops applying.
    expect(WEB_ADDENDUM).toMatch(/exactly\s+like\s+a\s+note/i);
    expect(WEB_ADDENDUM).toMatch(/your\s+own\s+recollection\s+is\s+still\s+not/i);
  });

  it('applies to one turn, and says so', () => {
    expect(WEB_ADDENDUM).toMatch(/this\s+question\s+and\s+no\s+other/i);
  });

  it('makes him say which half came from the web', () => {
    expect(WEB_ADDENDUM).toMatch(/say\s+where\s+it\s+came\s+from/i);
  });

  it('does not undo the length rule', () => {
    expect(WEB_ADDENDUM).toMatch(/one\s+sentence\s+still/i);
  });
});
