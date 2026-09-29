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

/*
 * Where Google is told to send them back.
 *
 * These mirror the server's own helpers rather than importing them, because
 * they live in index.ts, which starts a listener on import. The behaviour
 * they describe is exercised for real against a running server in the relay
 * checks; what is pinned here is the rule, so a change to it is deliberate.
 */
function reachableHost(host: string): boolean {
  const name = (host.split(':')[0] ?? '').toLowerCase();
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]') return true;
  if (name.endsWith('.ts.net')) return true;
  if (/^10\./.test(name) || /^192\.168\./.test(name)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(name)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(name)) return true;
  return false;
}

describe('the callback origin', () => {
  it('follows the places Helix is actually reached on', () => {
    // One fixed callback cannot serve both: on this machine Helix is
    // localhost, from a phone it is a tailnet name, and Google compares the
    // redirect_uri byte for byte.
    for (const host of [
      'localhost:3000',
      '127.0.0.1:3000',
      'helix.tail1234.ts.net',
      '100.101.102.103:3000',
      '192.168.1.40:3000',
      '10.0.0.5:3000',
      '172.16.0.9:3000',
    ]) {
      expect(reachableHost(host), host).toBe(true);
    }
  });

  it('refuses a host Helix could not be reached on', () => {
    // The Host header is the caller's to set and this value ends up in a URL
    // Google is told to send an authorisation code to.
    for (const host of [
      'evil.example.com',
      'ts.net.attacker.com',
      'google.com',
      '8.8.8.8',
      '',
      'notts.net.example',
    ]) {
      expect(reachableHost(host), host).toBe(false);
    }
  });

  it('is not fooled by a tailnet name as a prefix', () => {
    // endsWith, not includes: "helix.ts.net.attacker.com" is not a tailnet.
    expect(reachableHost('helix.ts.net.attacker.com')).toBe(false);
    expect(reachableHost('helix.ts.net')).toBe(true);
  });

  it('does not mistake 100.x outside the tailnet range for one', () => {
    expect(reachableHost('100.63.0.1')).toBe(false);
    expect(reachableHost('100.128.0.1')).toBe(false);
    expect(reachableHost('100.64.0.1')).toBe(true);
    expect(reachableHost('100.127.255.254')).toBe(true);
  });
});
