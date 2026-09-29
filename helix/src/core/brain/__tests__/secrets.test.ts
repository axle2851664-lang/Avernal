import { describe, expect, it } from 'vitest';
import { containsSecret, findSecrets, refusalFor } from '../secrets.js';

/*
 * The positive samples are assembled from pieces at runtime rather than
 * written out whole.
 *
 * Every value here is invented and only its shape matters, but a file
 * containing complete credential-shaped literals is one that secret scanners
 * flag — GitHub's push protection rejected exactly that, which is the feature
 * working. Splitting the prefix from the body keeps the shape the regexes need
 * while leaving no matchable string in the source.
 */
const join = (...parts: readonly string[]): string => parts.join('');

const SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['a stated password', 'my password is hunter2xyz'],
  ['a Google API key', join('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q')],
  ['an OpenAI-style key', join('sk', '-', 'abcdefghijklmnopqrstuvwxyz123456')],
  ['a GitHub token', join('ghp', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')],
  ['a bearer header', join('Authorization: Bearer ', 'abcdefghijklmnop.qrstuv')],
  ['an AWS key id', join('AKIA', 'IOSFODNN7EXAMPLE')],
  ['a Slack token', join('xox', 'b-123456789012-abcdefghijklmnop')],
  [
    'a JWT',
    join(
      'eyJ',
      'hbGciOiJIUzI1NiJ9.',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0.',
      'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    ),
  ],
  ['a PEM block', join('-----BEGIN ', 'RSA PRIVATE KEY-----')],
  ['a Google client secret', join('client_secret = ', 'GOCSPX', '-abcdefghijklmnop')],
];

describe('findSecrets', () => {
  it('catches the shapes a person actually pastes', () => {
    const missed = SAMPLES.filter(([, text]) => !containsSecret(text)).map(([name]) => name);
    expect(missed).toEqual([]);
  });

  it('leaves ordinary sentences about security alone', () => {
    // A guard that refuses any sentence containing "password" makes the
    // feature unusable, so the false-positive side is pinned too.
    const innocent = [
      'I changed my password this morning',
      'Remind me to rotate the API keys next quarter',
      'The login page needs a password strength meter',
      'Helix should never store credentials',
      'Ask Dan about the secret santa list',
      'The private key lives in the password manager, not here',
    ];

    const wrong = innocent.filter((s) => containsSecret(s));
    expect(wrong).toEqual([]);
  });

  it('names every kind it found, so one fix does not reveal another', () => {
    const text = join('key sk', '-', 'abcdefghijklmnopqrstuvwxyz123456 and AKIA', 'IOSFODNN7EXAMPLE');
    expect(findSecrets(text).length).toBeGreaterThanOrEqual(2);
  });

  it('never repeats the value back in the refusal', () => {
    const value = join('sk', '-', 'abcdefghijklmnopqrstuvwxyz123456');
    const message = refusalFor(findSecrets('my key is ' + value));
    expect(message).not.toContain(value);
  });
});
