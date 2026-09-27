import { describe, expect, it } from 'vitest';
import { capturesFrom } from '../listen.js';

const one = (utterance: string) => capturesFrom(utterance)[0];

describe('outright instructions', () => {
  it('catches the phrasings people use, and keeps only the substance', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['Remember this: the site ships on Friday', 'the site ships on Friday'],
      ['remember that the beds need mulching', 'the beds need mulching'],
      ['Please remember this — my sister is called Ada', 'my sister is called Ada'],
      ["don't forget the lease renews in March", 'the lease renews in March'],
      ['Do not forget that the key is with Sam', 'the key is with Sam'],
      ['keep in mind the budget is fixed', 'the budget is fixed'],
      ['make a note that the router is upstairs', 'the router is upstairs'],
    ];

    for (const [said, kept] of cases) {
      const capture = one(said);
      expect(capture?.text, said).toBe(kept);
      expect(capture?.category, said).toBe('long-term');
      expect(capture?.origin, said).toBe('user-command');
    }
  });

  it('drops the trailing full stop but not the sentence', () => {
    expect(one('Remember this: the site ships on Friday.')?.text).toBe('the site ships on Friday');
  });
});

describe('stated preferences', () => {
  it('keeps the whole sentence, because the fragment is not the preference', () => {
    const capture = one('I prefer short answers');
    expect(capture?.text).toBe('I prefer short answers');
    expect(capture?.category).toBe('preference');
    // Stated, not observed: Helix matched the phrase, it did not infer this.
    expect(capture?.origin).toBe('stated');
  });

  it('catches the standing-instruction shapes', () => {
    for (const said of [
      'I prefer short answers',
      'I like my coffee black',
      'I hate being called sir',
      "I don't like long explanations",
      'From now on, use metric',
      'Always give me the number first',
      'Never mention the weather',
      'Call me Sam',
      'Stop calling me sir',
    ]) {
      expect(one(said)?.category, said).toBe('preference');
    }
  });
});

describe('what it must not catch', () => {
  it('never captures from a question', () => {
    // The failure that matters is keeping something the user never said.
    for (const asked of [
      'Do I prefer tea or coffee?',
      'What should I always do first?',
      'Can you remember this for me?',
      'Should I call me Sam?',
      'what do you remember',
      'How do I stop getting these emails?',
    ]) {
      expect(capturesFrom(asked), asked).toEqual([]);
    }
  });

  it('leaves ordinary sentences alone', () => {
    for (const said of [
      'what is my storage ceiling',
      'the website project uses the house style',
      'I went to the shop',
      'he said he would remember it',
      'this always happens with the router',
      'generate an image of a lighthouse',
      'sync my mail',
    ]) {
      expect(capturesFrom(said), said).toEqual([]);
    }
  });

  it('will not keep a fragment', () => {
    expect(capturesFrom('remember this:')).toEqual([]);
    expect(capturesFrom('remember that a')).toEqual([]);
  });

  it('stores one sentence once, not twice', () => {
    // "Remember this: always use metric" matches both an instruction and a
    // preference shape; two copies of one sentence is how a store becomes
    // impossible to reason about.
    expect(capturesFrom('Remember this: always use metric')).toHaveLength(1);
  });

  it('says which phrase matched, so it can be explained', () => {
    expect(one('Remember this: the key is with Sam')?.trigger).toBe('remember this');
    expect(one('I prefer short answers')?.trigger).toContain('I prefer');
  });
});
