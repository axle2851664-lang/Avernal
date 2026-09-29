import { describe, expect, it } from 'vitest';
import { HelixMind, MAX_QUESTION_LENGTH, MindError } from '../claude.js';

const KEY = 'test-anthropic-key-not-real';

describe('configuration', () => {
  it('is not configured without a key, and says which variable to set', () => {
    const mind = new HelixMind('');
    expect(mind.configured).toBe(false);
    expect(mind.status().reason).toContain('ANTHROPIC_API_KEY');
  });

  it('never puts the key in its own status', () => {
    expect(JSON.stringify(new HelixMind(KEY).status())).not.toContain(KEY);
  });

  it('reads the environment and nowhere else for the key', () => {
    expect(HelixMind.fromEnvironment({ ANTHROPIC_API_KEY: KEY } as NodeJS.ProcessEnv).configured).toBe(true);
    expect(HelixMind.fromEnvironment({} as NodeJS.ProcessEnv).configured).toBe(false);
  });

  it('names the model it will use even before it is configured', () => {
    // So the UI can say what it would run, rather than "unknown".
    expect(new HelixMind('').status().model).toBe('claude-opus-5');
  });
});

describe('answer', () => {
  it('refuses before calling out when there is no key', async () => {
    await expect(new HelixMind('').answer('hello', '', 'system')).rejects.toBeInstanceOf(MindError);
  });

  it('will not send an empty question, or an essay', async () => {
    const mind = new HelixMind(KEY);
    await expect(mind.answer('   ', '', 'system')).rejects.toThrow('no question');
    await expect(mind.answer('x'.repeat(MAX_QUESTION_LENGTH + 1), '', 'system')).rejects.toThrow(
      'the limit is'
    );
  });
});
