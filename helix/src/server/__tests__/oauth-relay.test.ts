import { describe, expect, it } from 'vitest';
import {
  createState,
  explainGoogleError,
  isRelayService,
  relayPage,
  serviceLabel,
  STATE_TTL_MS,
  verifyState,
} from '../oauth-relay.js';

const SECRET = 'a-shared-token-for-tests';

describe('state', () => {
  it('accepts a callback from a flow it started', () => {
    expect(verifyState(createState('gmail', SECRET), 'gmail', SECRET).ok).toBe(true);
  });

  it('refuses one it did not sign', () => {
    // The whole point: without this, anything that can make the browser hit
    // the callback can bind its own Google account to this Helix.
    const forged = 'gmail.' + (Date.now() + STATE_TTL_MS) + '.abcdef.' + 'f'.repeat(64);
    expect(verifyState(forged, 'gmail', SECRET).ok).toBe(false);
  });

  it('refuses one signed with a different secret', () => {
    const other = createState('gmail', 'a-different-token');
    expect(verifyState(other, 'gmail', SECRET).ok).toBe(false);
  });

  it('refuses a state issued for another service', () => {
    const state = createState('youtube', SECRET);
    const check = verifyState(state, 'gmail', SECRET);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain('different service');
  });

  it('refuses one that has expired', () => {
    const state = createState('gmail', SECRET, 0);
    const check = verifyState(state, 'gmail', SECRET, STATE_TTL_MS + 1);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain('took too long');
  });

  it('refuses anything that is not a state at all', () => {
    for (const value of [undefined, '', 'nonsense', 'a.b.c', 42, null]) {
      expect(verifyState(value, 'gmail', SECRET).ok, String(value)).toBe(false);
    }
  });

  it('does not repeat itself', () => {
    expect(createState('gmail', SECRET)).not.toBe(createState('gmail', SECRET));
  });
});

describe('explainGoogleError', () => {
  it('turns the refusal people actually hit into the setting to change', () => {
    // access_denied on a Testing app is the single most common wall, and
    // Google's own screen says nothing about test users.
    const message = explainGoogleError('access_denied', 'someone@example.com');
    expect(message).toContain('Testing');
    expect(message).toContain('Test users');
    expect(message).toContain('someone@example.com');
  });

  it('explains a redirect mismatch in terms of what has to match', () => {
    expect(explainGoogleError('redirect_uri_mismatch')).toContain('scheme, host, port and path');
  });

  it('still says something useful for a code it does not know', () => {
    expect(explainGoogleError('some_new_code')).toContain('some_new_code');
  });
});

describe('relayPage', () => {
  it('says which way it went and offers a way back', () => {
    const page = relayPage({ ok: true, title: 'Gmail is connected', detail: 'Read-only.' });
    expect(page).toContain('Connected');
    expect(page).toContain('href="/"');
  });

  it('escapes what it is given', () => {
    // The detail can carry a Google error string; it is not a place to let
    // markup through.
    const page = relayPage({ ok: false, title: 'x', detail: '<img src=x onerror=alert(1)>' });
    expect(page).not.toContain('<img');
    expect(page).toContain('&lt;img');
  });
});

describe('services', () => {
  it('knows the two it connects and nothing else', () => {
    expect(isRelayService('gmail')).toBe(true);
    expect(isRelayService('youtube')).toBe(true);
    for (const value of ['drive', 'calendar', '', '../etc', null]) {
      expect(isRelayService(value), String(value)).toBe(false);
    }
  });

  it('labels them as a person would write them', () => {
    expect(serviceLabel('gmail')).toBe('Gmail');
    expect(serviceLabel('youtube')).toBe('YouTube');
  });
});
