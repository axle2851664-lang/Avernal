/**
 * The keys, and the file they live in.
 *
 * This is the "explicitly designed secure mechanism" the memory rules refer
 * to when they refuse to remember a credential. Memory is a JSON file Helix
 * reads back to a language model; this is a 0600 file on the same disk that
 * nothing reads back to anyone. The difference is not the disk, it is that
 * one of them has a route that returns its contents and this one does not.
 *
 * Three rules hold everywhere below:
 *
 *   1. A secret's value is never returned, logged, or put in an error. The
 *      only thing that leaves here is whether one is set and its last four
 *      characters, which is enough to tell two keys apart and not enough to
 *      use either.
 *   2. Writing preserves every line of the file it did not set, including
 *      comments and settings Helix knows nothing about.
 *   3. A write that fails leaves the old file intact — temp file, then
 *      rename, as the memory store does.
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** What can be set from the settings screen, and what it turns on. */
export interface Setting {
  readonly key: string;
  readonly label: string;
  /** One line saying what setting it buys. Shown under the field. */
  readonly note: string;
  /** Secrets are masked coming back out. Everything else is shown. */
  readonly secret: boolean;
  /** The group it belongs to, so the screen can lay them out. */
  readonly group: 'mind' | 'voice' | 'google';
}

export const SETTINGS: readonly Setting[] = [
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic key',
    note: 'Lets Helix think of an answer. Without it he cannot reply at all.',
    secret: true,
    group: 'mind',
  },
  {
    key: 'ELEVENLABS_API_KEY',
    label: 'ElevenLabs key',
    note: 'Lets Helix hear you. Also needed before he can speak.',
    secret: true,
    group: 'voice',
  },
  {
    key: 'ELEVENLABS_VOICE_ID',
    label: 'Voice id',
    note: 'Which voice he answers in. Without it he answers on screen only.',
    secret: false,
    group: 'voice',
  },
  {
    key: 'ELEVENLABS_MODEL_ID',
    label: 'Speech model',
    note: 'Optional. Defaults to eleven_multilingual_v2.',
    secret: false,
    group: 'voice',
  },
  {
    key: 'ELEVENLABS_STT_MODEL_ID',
    label: 'Transcription model',
    note: 'Optional. Defaults to scribe_v2.',
    secret: false,
    group: 'voice',
  },
  {
    key: 'GMAIL_CLIENT_ID',
    label: 'Gmail client id',
    note: 'From a Google Cloud OAuth client. See GOOGLE_SETUP.md.',
    secret: false,
    group: 'google',
  },
  {
    key: 'GMAIL_CLIENT_SECRET',
    label: 'Gmail client secret',
    note: 'The secret beside that client id.',
    secret: true,
    group: 'google',
  },
  {
    key: 'YOUTUBE_CLIENT_ID',
    label: 'YouTube client id',
    note: 'May be the same client as Gmail, with YouTube scopes added.',
    secret: false,
    group: 'google',
  },
  {
    key: 'YOUTUBE_CLIENT_SECRET',
    label: 'YouTube client secret',
    note: 'The secret beside that client id.',
    secret: true,
    group: 'google',
  },
];

const SETTABLE = new Map(SETTINGS.map((setting) => [setting.key, setting]));

/** What a caller is allowed to know about one setting. Never its value. */
export interface SettingState {
  readonly key: string;
  readonly label: string;
  readonly note: string;
  readonly secret: boolean;
  readonly group: string;
  readonly set: boolean;
  /**
   * Enough to recognise a value, never enough to use one: the last four
   * characters of a secret, or the whole of a non-secret.
   */
  readonly hint: string | null;
}

export class SettingsError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = 'SettingsError';
    this.status = status;
  }
}

/**
 * A key long enough to be worth masking.
 *
 * Below this the last four characters would be most of it, so nothing is
 * shown at all rather than a hint that gives the value away.
 */
const MASKABLE_LENGTH = 12;

function hintFor(setting: Setting, value: string): string | null {
  if (value === '') return null;
  if (!setting.secret) return value;
  return value.length < MASKABLE_LENGTH ? '····' : '····' + value.slice(-4);
}

/**
 * Parse a .env file into pairs, keeping the original lines.
 *
 * Deliberately small: this reads a file this same program wrote, plus
 * whatever the user typed into it by hand. It is not trying to be dotenv —
 * it only needs to find `KEY=value` lines so it can replace them, and to
 * leave everything it does not understand exactly where it found it.
 */
function splitLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  const at = trimmed.indexOf('=');
  if (at <= 0) return null;

  const key = trimmed.slice(0, at).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = trimmed.slice(at + 1).trim();
  // Quoted values are unwrapped, since that is how they are written back.
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    const quote = value[0] as string;
    if (value.endsWith(quote)) value = value.slice(1, -1);
  }
  return { key, value };
}

/**
 * Quote a value if it needs it.
 *
 * A key with a space or a hash in it would otherwise be truncated on the way
 * back in, which is the kind of bug that presents as "the service rejected my
 * key" hours later.
 */
function quote(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./:+@-]+$/.test(value)) return value;
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export class SettingsFile {
  readonly #path: string;

  public constructor(dataRoot: string) {
    this.#path = join(dataRoot, '.env');
  }

  /** Where the keys are kept, so the screen can say so. Not a secret. */
  public get path(): string {
    return this.#path;
  }

  #read(): Map<string, string> {
    const found = new Map<string, string>();
    if (!existsSync(this.#path)) return found;

    for (const line of readFileSync(this.#path, 'utf8').split(/\r?\n/)) {
      const pair = splitLine(line);
      if (pair !== null) found.set(pair.key, pair.value);
    }
    return found;
  }

  /**
   * What is set, for the screen.
   *
   * Reads the file rather than process.env so that a key set in the shell for
   * this run is distinguishable from one saved here — the screen can then say
   * "set in your environment" rather than showing an empty box beside a
   * feature that plainly works.
   */
  public state(env: NodeJS.ProcessEnv = process.env): readonly SettingState[] {
    const onDisk = this.#read();

    return SETTINGS.map((setting) => {
      const saved = onDisk.get(setting.key) ?? '';
      const live = (env[setting.key] ?? '').trim();
      const value = saved !== '' ? saved : live;

      return {
        key: setting.key,
        label: setting.label,
        note: setting.note,
        secret: setting.secret,
        group: setting.group,
        set: value !== '',
        hint: hintFor(setting, value),
      };
    });
  }

  /**
   * Save what was sent, and apply it to this process.
   *
   * Only keys in SETTINGS are accepted. An unknown key is refused rather than
   * written, because the whole value of an allowlist is that a request cannot
   * name HELIX_TOKEN, or PATH, and have this file write it.
   *
   * An empty string clears a setting. That is the only way to unset one from
   * the screen, and it has to work, or a key pasted into the wrong box is
   * permanent.
   */
  public save(
    updates: Readonly<Record<string, unknown>>,
    env: NodeJS.ProcessEnv = process.env
  ): readonly string[] {
    const changes = new Map<string, string>();

    for (const [key, raw] of Object.entries(updates)) {
      const setting = SETTABLE.get(key);
      if (setting === undefined) {
        throw new SettingsError('Helix does not have a setting called ' + key + '.', 400);
      }
      if (typeof raw !== 'string') {
        throw new SettingsError(setting.label + ' has to be text.', 400);
      }

      const value = raw.trim();
      // A pasted value often brings a newline with it, and a newline in the
      // middle of this file would truncate the key and orphan the rest of it
      // as a line of its own.
      if (/[\r\n]/.test(value)) {
        throw new SettingsError(setting.label + ' cannot contain a line break.', 400);
      }
      if (value.length > 400) {
        throw new SettingsError(setting.label + ' is too long to be a key.', 400);
      }
      changes.set(key, value);
    }

    if (changes.size === 0) return [];

    this.#write(changes);

    // Applied to this process as well as to the file, so nothing has to be
    // restarted. The caller rebuilds whatever reads these at construction.
    for (const [key, value] of changes) {
      if (value === '') delete env[key];
      else env[key] = value;
    }

    return [...changes.keys()];
  }

  /**
   * Replace the named lines, keep every other one.
   *
   * Written to a temp file and renamed, so an interrupted write cannot leave
   * a half-file where the keys used to be.
   */
  #write(changes: ReadonlyMap<string, string>): void {
    const existing = existsSync(this.#path) ? readFileSync(this.#path, 'utf8') : '';
    const lines = existing === '' ? [] : existing.split(/\r?\n/);
    const written = new Set<string>();

    const kept: string[] = [];
    for (const line of lines) {
      const pair = splitLine(line);
      if (pair === null || !changes.has(pair.key)) {
        kept.push(line);
        continue;
      }
      const value = changes.get(pair.key) as string;
      written.add(pair.key);
      // A cleared setting loses its line rather than keeping an empty one, so
      // the file does not fill up with the ghosts of keys.
      if (value !== '') kept.push(pair.key + '=' + quote(value));
    }

    const added = [...changes.entries()].filter(([key, value]) => !written.has(key) && value !== '');
    if (added.length > 0) {
      if (kept.length > 0 && (kept[kept.length - 1] ?? '') !== '') kept.push('');
      kept.push('# Written by Helix. This file holds credentials — keep it out of git.');
      for (const [key, value] of added) kept.push(key + '=' + quote(value));
    }

    let body = kept.join('\n');
    if (body !== '' && !body.endsWith('\n')) body += '\n';

    const temp = this.#path + '.' + process.pid + '.tmp';
    try {
      // 0600 from the moment it exists. Writing it readable and fixing it
      // afterwards leaves a window where it is not.
      writeFileSync(temp, body, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, this.#path);
      chmodSync(this.#path, 0o600);
    } catch (error) {
      try {
        if (existsSync(temp)) unlinkSync(temp);
      } catch {
        // Nothing useful to do about a failed cleanup of a failed write.
      }
      // The message is written here rather than passed through: an fs error
      // carries the path, and the path is the one thing about this file worth
      // not putting in a response body.
      throw new SettingsError('Could not save the settings file.', 500);
    }
  }
}
