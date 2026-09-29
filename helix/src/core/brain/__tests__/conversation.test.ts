import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationLog, MAX_TURNS, REPLAY_DEPTH } from '../conversation.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helix-talk-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function say(log: ConversationLog, question: string, session = 's1'): void {
  log.record({ question, answer: 'Quite, sir.', sessionId: session });
}

describe('ConversationLog', () => {
  it('survives a restart', () => {
    // The whole point: a second log over the same root is what a restart is.
    const first = new ConversationLog(root);
    first.record({ question: 'What is my storage ceiling?', answer: 'Forty gigabytes.', sessionId: 's1' });

    const reopened = new ConversationLog(root);
    expect(reopened.size).toBe(1);
    expect(reopened.recent()[0]?.question).toBe('What is my storage ceiling?');
  });

  it('replays across sessions, not just the current one', () => {
    const log = new ConversationLog(root);
    say(log, 'first', 'yesterday');
    say(log, 'second', 'today');

    const recent = new ConversationLog(root).recent();
    expect(recent.map((t) => t.question)).toEqual(['first', 'second']);
    expect(new ConversationLog(root).sessions).toBe(2);
  });

  it('hands back the last few, oldest first, ready to replay', () => {
    const log = new ConversationLog(root);
    for (let i = 0; i < REPLAY_DEPTH + 4; i += 1) say(log, 'q' + i);

    const recent = log.recent();
    expect(recent).toHaveLength(REPLAY_DEPTH);
    expect(recent[0]?.question).toBe('q4');
    expect(recent[recent.length - 1]?.question).toBe('q' + (REPLAY_DEPTH + 3));
  });

  it('refuses to write down a credential, and says it did not', () => {
    const log = new ConversationLog(root);
    const result = log.record({
      question: 'remember that my password is hunter2xyz',
      answer: 'Noted.',
      sessionId: 's1',
    });

    expect(result.kept).toBe(false);
    if (!result.kept) expect(result.reason).toContain('credential');
    expect(log.size).toBe(0);
    // And not through the answer either.
    expect(
      log.record({ question: 'what is it', answer: 'It is ' + 'sk' + '-abcdefghijklmnopqrstuvwxyz123456', sessionId: 's1' }).kept
    ).toBe(false);
  });

  it('never grows past its ceiling, and drops the oldest first', () => {
    const log = new ConversationLog(root);
    for (let i = 0; i < MAX_TURNS + 25; i += 1) say(log, 'q' + i);

    expect(log.size).toBe(MAX_TURNS);
    expect(log.all()[0]?.question).toBe('q25');
    expect(log.all()[MAX_TURNS - 1]?.question).toBe('q' + (MAX_TURNS + 24));
  });

  it('searches both halves of an exchange, newest first', () => {
    const log = new ConversationLog(root);
    log.record({ question: 'about the garden', answer: 'Mulch in spring.', sessionId: 's1' });
    log.record({ question: 'about the website', answer: 'House style guide.', sessionId: 's1' });

    expect(log.search('garden')).toHaveLength(1);
    expect(log.search('MULCH')).toHaveLength(1);
    expect(log.search('house style')[0]?.question).toBe('about the website');
    expect(log.search('')).toHaveLength(2);
  });

  it('forgets one turn, or all of them', () => {
    const log = new ConversationLog(root);
    say(log, 'one');
    say(log, 'two');

    const id = log.all()[0]?.id ?? '';
    expect(log.forget(id)).toBe(true);
    expect(log.forget(id)).toBe(false);
    expect(log.size).toBe(1);

    expect(log.clear()).toBe(1);
    expect(log.clear()).toBe(0);
    expect(new ConversationLog(root).size).toBe(0);
  });

  it('keeps a corrupt transcript instead of overwriting it', () => {
    const path = join(root, 'helix-conversation.json');
    writeFileSync(path, 'not json at all', 'utf8');

    const log = new ConversationLog(root);
    expect(log.size).toBe(0);
    say(log, 'after');
    expect(JSON.parse(readFileSync(path, 'utf8')).turns).toHaveLength(1);
  });
});
