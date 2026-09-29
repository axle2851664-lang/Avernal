import { describe, expect, it } from 'vitest';

import { notepadIntent } from '../notepad-intent.js';

const act = (said: string) => notepadIntent(said)?.action ?? null;
const subject = (said: string) => notepadIntent(said)?.subject ?? null;

describe('opening the notepad', () => {
  it('recognises the ways people ask for it', () => {
    for (const said of [
      'open notepad',
      'Helix, open my notepad',
      'open my notes',
      'show my notes',
      'show me my notes',
      'list notes',
      'read my notes',
      'bring up my notebook',
      'open note pad',
      'notepad',
      'my notes',
      'Helix, notebook',
    ]) {
      expect(act(said), said).toBe('open');
    }
  });
});

describe('creating a note', () => {
  it('recognises the ways people ask for one', () => {
    for (const said of [
      'create a note',
      'new note',
      'make a note',
      'add a note',
      'write a note',
      'save a note',
      'store a note',
      'jot a note',
    ]) {
      expect(act(said), said).toBe('create');
    }
  });

  it('takes the title or the text with it', () => {
    expect(subject('create a note called Reselling Ideas')).toBe('Reselling Ideas');
    expect(subject('make a note titled Blender')).toBe('Blender');
    expect(subject('add a note saying find better suppliers')).toBe('find better suppliers');
    expect(subject('save this to my notes: check the margins')).toBe(': check the margins');
  });

  it('recognises adding to the notes rather than naming one', () => {
    for (const said of [
      'add this to my notes',
      'put this in my notes',
      'save this in my notebook',
      'store that in my notes',
    ]) {
      expect(act(said), said).toBe('create');
    }
  });
});

describe('searching', () => {
  it('recognises the ways people go looking', () => {
    for (const said of [
      'find my note about the reselling business',
      'search my notes for Blender',
      'search notes about suppliers',
      'look for a note about margins',
      'what did I write about my reselling project',
      'what did I note about the vault',
    ]) {
      expect(act(said), said).toBe('search');
    }
  });

  it('carries what to look for', () => {
    expect(subject('find my note about the reselling business')).toBe('reselling business');
    expect(subject('search my notes for Blender')).toBe('Blender');
    expect(subject('what did I write about my reselling project')).toBe('reselling project');
  });
});

describe('deleting', () => {
  it('reads as a delete even though it mentions a note about something', () => {
    // Order matters: this contains "note about", which the search rule would
    // also match. Deleting the wrong thing because a rule fired in the wrong
    // order is the failure this ordering exists to prevent.
    expect(act('delete my note about Blender')).toBe('delete');
    expect(subject('delete my note about Blender')).toBe('Blender');
    expect(act('delete that note')).toBe('delete');
    expect(act('remove the note called Blender')).toBe('delete');
  });
});

describe('exporting', () => {
  it('recognises the ways people ask for a copy', () => {
    for (const said of ['export my notes', 'back up my notes', 'backup my notepad', 'export notes']) {
      expect(act(said), said).toBe('export');
    }
  });
});

describe('everything else', () => {
  it('stays out of the way of ordinary talk', () => {
    // Nearly everything anyone says is not about the notepad. A false
    // positive here hijacks a question Helix should simply have answered.
    for (const said of [
      'what is my storage ceiling',
      'what is the weather',
      'remember this: I take my answers short',
      'hello',
      'what can you do',
      'how many notes do I have',
      'tell me a joke',
      '',
      '   ',
    ]) {
      expect(notepadIntent(said), said).toBeNull();
    }
  });

  it('does not treat "remember this" as a notepad command', () => {
    // It is already a memory instruction with its own rules and its own
    // refusals. Routing it here as well would store it twice, in two places,
    // under two sets of rules.
    expect(notepadIntent('remember this: I prefer terse answers')).toBeNull();
  });
});

describe('what a search intent is for', () => {
  it('separates going looking from asking a question', () => {
    // These two are treated differently on the server. An ordinary question
    // keeps the grounding threshold, which is what stops Helix answering out
    // of a note that merely shares a word. An explicit hunt lowers it,
    // because the whole request was to go looking — a word mentioned once in
    // the middle of a long note is exactly what "find my note about X" means.
    expect(notepadIntent('find my note about Sam')?.action).toBe('search');
    expect(notepadIntent('what did I write about suppliers')?.action).toBe('search');

    // Not hunts. These stay on the strict path.
    expect(notepadIntent('tell me about suppliers')).toBeNull();
    expect(notepadIntent('what is my storage ceiling')).toBeNull();
  });
});
