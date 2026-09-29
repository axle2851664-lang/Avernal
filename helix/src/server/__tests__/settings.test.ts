import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SETTINGS, SettingsError, SettingsFile } from '../settings.js';

/*
 * Key-shaped, and assembled at runtime rather than written as a literal.
 * GitHub's push protection scans for the real shapes, and a fixture that
 * looks exactly like a live credential gets a commit rejected — the shape is
 * what matters to these tests, not the spelling.
 */
const KEY = ['sk', 'ant', 'api03', 'ZZZZwwwwvvvvuuuuttttssssrrrr9876'].join('-');

let root = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helix-settings-'));
  env = {};
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function file(): string {
  return readFileSync(join(root, '.env'), 'utf8');
}

describe('reading', () => {
  it('reports nothing set on a fresh install, without creating a file', () => {
    const settings = new SettingsFile(root);
    const state = settings.state(env);

    expect(state).toHaveLength(SETTINGS.length);
    expect(state.every((entry) => entry.set === false)).toBe(true);
    expect(state.every((entry) => entry.hint === null)).toBe(true);
    // Reading must not write. A settings screen someone opens and closes
    // should leave no trace.
    expect(() => statSync(join(root, '.env'))).toThrow();
  });

  it('never returns a secret, only enough to recognise it', () => {
    const settings = new SettingsFile(root);
    settings.save({ ANTHROPIC_API_KEY: KEY }, env);

    const entry = settings.state(env).find((s) => s.key === 'ANTHROPIC_API_KEY');
    expect(entry?.set).toBe(true);
    expect(entry?.hint).toBe('····' + KEY.slice(-4));
    // The whole point of this file: the value does not come back out.
    expect(JSON.stringify(settings.state(env))).not.toContain(KEY);
  });

  it('shows a short secret as nothing rather than as most of itself', () => {
    const settings = new SettingsFile(root);
    settings.save({ ANTHROPIC_API_KEY: 'abc123' }, env);

    expect(settings.state(env).find((s) => s.key === 'ANTHROPIC_API_KEY')?.hint).toBe('····');
  });

  it('shows a non-secret in full, because it is not one', () => {
    const settings = new SettingsFile(root);
    settings.save({ ELEVENLABS_VOICE_ID: 'voice-abc-123' }, env);

    expect(settings.state(env).find((s) => s.key === 'ELEVENLABS_VOICE_ID')?.hint).toBe(
      'voice-abc-123'
    );
  });

  it('counts a key set in the shell as set', () => {
    // Otherwise the screen shows an empty box beside a feature that plainly
    // works, and the obvious next move is to paste the key in again.
    const settings = new SettingsFile(root);
    const state = settings.state({ ANTHROPIC_API_KEY: KEY } as NodeJS.ProcessEnv);

    expect(state.find((s) => s.key === 'ANTHROPIC_API_KEY')?.set).toBe(true);
  });
});

describe('writing', () => {
  it('writes a file only this user can read', () => {
    const settings = new SettingsFile(root);
    settings.save({ ANTHROPIC_API_KEY: KEY }, env);

    // 0600. A credentials file the rest of the machine can read is the whole
    // failure this class exists to avoid.
    expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600);
  });

  it('applies the value to the process, so nothing has to restart', () => {
    const settings = new SettingsFile(root);
    settings.save({ ANTHROPIC_API_KEY: KEY }, env);

    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
  });

  it('keeps every line it did not set', () => {
    writeFileSync(
      join(root, '.env'),
      '# my own note\nPORT=4000\nANTHROPIC_API_KEY=old-value-here\nHELIX_TOKEN=keep-me\n'
    );

    new SettingsFile(root).save({ ANTHROPIC_API_KEY: KEY }, env);

    const after = file();
    expect(after).toContain('# my own note');
    expect(after).toContain('PORT=4000');
    expect(after).toContain('HELIX_TOKEN=keep-me');
    expect(after).toContain('ANTHROPIC_API_KEY=' + KEY);
    expect(after).not.toContain('old-value-here');
  });

  it('replaces a key in place rather than appending a second one', () => {
    const settings = new SettingsFile(root);
    settings.save({ ANTHROPIC_API_KEY: 'first-value-aaaa' }, env);
    settings.save({ ANTHROPIC_API_KEY: 'second-value-bbbb' }, env);

    const lines = file().split('\n').filter((l) => l.startsWith('ANTHROPIC_API_KEY='));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('second-value-bbbb');
  });

  it('clears a setting with an empty string, and drops its line', () => {
    // A key pasted into the wrong box has to be removable, or it is permanent.
    const settings = new SettingsFile(root);
    settings.save({ ELEVENLABS_VOICE_ID: 'voice-1' }, env);
    settings.save({ ELEVENLABS_VOICE_ID: '' }, env);

    expect(file()).not.toContain('ELEVENLABS_VOICE_ID');
    expect(env.ELEVENLABS_VOICE_ID).toBeUndefined();
    expect(settings.state(env).find((s) => s.key === 'ELEVENLABS_VOICE_ID')?.set).toBe(false);
  });

  it('quotes a value that would not survive a round trip', () => {
    const settings = new SettingsFile(root);
    settings.save({ ELEVENLABS_VOICE_ID: 'has space and # hash' }, env);

    // Unquoted, the hash starts a comment and the value silently truncates —
    // which presents hours later as "the service rejected my key".
    expect(settings.state({}).find((s) => s.key === 'ELEVENLABS_VOICE_ID')?.hint).toBe(
      'has space and # hash'
    );
  });

  it('refuses a key it does not know', () => {
    // The allowlist is the point: without it a request could name HELIX_TOKEN
    // or PATH and have this write it.
    const settings = new SettingsFile(root);

    expect(() => settings.save({ HELIX_TOKEN: 'nope' }, env)).toThrow(SettingsError);
    expect(() => settings.save({ PATH: '/tmp' }, env)).toThrow(/does not have a setting/);
    expect(() => statSync(join(root, '.env'))).toThrow();
  });

  it('refuses a line break, which would orphan half the key', () => {
    const settings = new SettingsFile(root);

    expect(() => settings.save({ ANTHROPIC_API_KEY: KEY + '\nPATH=/tmp' }, env)).toThrow(
      /line break/
    );
    expect(() => statSync(join(root, '.env'))).toThrow();
  });

  it('refuses something that is not text, and something absurdly long', () => {
    const settings = new SettingsFile(root);

    expect(() => settings.save({ ANTHROPIC_API_KEY: 42 as unknown as string }, env)).toThrow(
      /has to be text/
    );
    expect(() => settings.save({ ANTHROPIC_API_KEY: 'x'.repeat(401) }, env)).toThrow(/too long/);
  });

  it('trims a pasted value', () => {
    // Copying a key out of a web page brings whitespace with it more often
    // than not.
    const settings = new SettingsFile(root);
    settings.save({ ANTHROPIC_API_KEY: '  ' + KEY + '  ' }, env);

    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
  });

  it('reports which keys it wrote and nothing about their values', () => {
    const settings = new SettingsFile(root);
    const saved = settings.save({ ANTHROPIC_API_KEY: KEY, ELEVENLABS_VOICE_ID: 'v1' }, env);

    expect([...saved].sort()).toEqual(['ANTHROPIC_API_KEY', 'ELEVENLABS_VOICE_ID']);
  });

  it('does nothing at all when sent nothing', () => {
    const settings = new SettingsFile(root);

    expect(settings.save({}, env)).toEqual([]);
    expect(() => statSync(join(root, '.env'))).toThrow();
  });
});

describe('the catalogue', () => {
  it('marks every credential as a secret', () => {
    // A client id is public; a client secret and an API key are not. Getting
    // this wrong is what would print a key on the screen.
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ELEVENLABS_API_KEY',
      'GMAIL_CLIENT_SECRET',
      'YOUTUBE_CLIENT_SECRET',
    ]) {
      expect(SETTINGS.find((s) => s.key === key)?.secret, key).toBe(true);
    }
  });

  it('offers nothing that would change how the server is reached', () => {
    // HELIX_TOKEN, HOST, PORT and ALLOWED_ORIGINS are how this server is
    // protected. A screen that can rewrite them is a screen that can unlock
    // the door it is behind.
    const keys = SETTINGS.map((s) => s.key);
    for (const forbidden of ['HELIX_TOKEN', 'HOST', 'PORT', 'ALLOWED_ORIGINS', 'HELIX_DATA']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('says what each one buys', () => {
    for (const setting of SETTINGS) {
      expect(setting.note.length, setting.key).toBeGreaterThan(10);
      expect(setting.label.length, setting.key).toBeGreaterThan(2);
    }
  });
});
