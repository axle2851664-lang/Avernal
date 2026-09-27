/**
 * The Google OAuth relay.
 *
 * Helix never sees a Google password. It sends the user to Google, Google asks
 * them, and Google hands back a code that this server exchanges for tokens.
 * That is the whole point of the flow and the reason none of it can be
 * short-circuited: consent is Google's to ask for and the user's to give.
 *
 * What lives here is the part that is easy to get wrong and impossible to
 * debug from a JSON error: proving a callback belongs to a flow this server
 * started, and turning Google's error codes into a sentence that says what to
 * change.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Long enough that a user who wanders off still lands, short enough to expire. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * A signed `state` for the round trip.
 *
 * Without one, anything that can make the user's browser hit the callback can
 * bind *its* Google account to this Helix — the classic OAuth login CSRF. The
 * value carries the service and an expiry so a stale or swapped callback is
 * refused rather than acted on.
 */
export function createState(service: string, secret: string, now: number = Date.now()): string {
  const payload = service + '.' + (now + STATE_TTL_MS) + '.' + randomBytes(12).toString('hex');
  return payload + '.' + sign(payload, secret);
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export type StateCheck =
  | { readonly ok: true; readonly service: string }
  | { readonly ok: false; readonly reason: string };

export function verifyState(
  state: unknown,
  service: string,
  secret: string,
  now: number = Date.now()
): StateCheck {
  if (typeof state !== 'string' || state === '') {
    return { ok: false, reason: 'That callback did not come from a sign-in Helix started.' };
  }

  const parts = state.split('.');
  if (parts.length !== 4) {
    return { ok: false, reason: 'That callback did not come from a sign-in Helix started.' };
  }

  const payload = parts.slice(0, 3).join('.');
  const expected = sign(payload, secret);
  const given = parts[3] ?? '';

  // Both sides are hex of the same length, so a constant-time compare is safe
  // to reach for without hashing first.
  if (given.length !== expected.length) {
    return { ok: false, reason: 'That callback did not come from a sign-in Helix started.' };
  }
  if (!timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))) {
    return { ok: false, reason: 'That callback did not come from a sign-in Helix started.' };
  }

  if (parts[0] !== service) {
    return { ok: false, reason: 'That sign-in was for a different service.' };
  }

  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires < now) {
    return { ok: false, reason: 'That sign-in took too long. Start it again.' };
  }

  return { ok: true, service };
}

/**
 * What Google's failure actually means, and what to change.
 *
 * Google returns these as bare codes and its own consent screen explains
 * nothing useful. Every one of these is a setting in the Cloud Console, so the
 * message names the setting rather than the code.
 */
export function explainGoogleError(code: string, email?: string): string {
  const who = email === undefined || email === '' ? 'your Google account' : email;

  switch (code) {
    case 'access_denied':
      return (
        'Google refused. If you did not press Cancel, the app is still in Testing and ' +
        who +
        ' is not on its test-user list. Add it under APIs & Services, OAuth consent screen, Audience, Test users.'
      );
    case 'redirect_uri_mismatch':
      return (
        'The redirect URI Helix sent is not one registered on the client. Register the exact ' +
        'URI — scheme, host, port and path all have to match — or switch the client to a ' +
        'Desktop app, which allows loopback addresses without registering them.'
      );
    case 'invalid_client':
      return 'Google does not recognise that client id and secret. Check they are from the same OAuth client, and that neither has a stray space.';
    case 'invalid_grant':
      return 'That authorisation code is stale or already used. Start the sign-in again.';
    case 'invalid_scope':
      return 'Google rejected the requested permissions. The API for them may not be enabled on the project.';
    case 'admin_policy_enforced':
      return 'A Google Workspace policy blocks this app for ' + who + '. An administrator has to allow it.';
    case 'org_internal':
      return 'The consent screen is set to Internal, so only accounts in that Workspace can use it. Set it to External, or sign in with an account in the organisation.';
    default:
      return 'Google refused the sign-in (' + code + ').';
  }
}

/** Services the relay knows how to connect. */
export const RELAY_SERVICES = ['gmail', 'youtube'] as const;
export type RelayService = (typeof RELAY_SERVICES)[number];

export function isRelayService(value: unknown): value is RelayService {
  return typeof value === 'string' && (RELAY_SERVICES as readonly string[]).includes(value);
}

const LABELS: Readonly<Record<RelayService, string>> = { gmail: 'Gmail', youtube: 'YouTube' };

export function serviceLabel(service: RelayService): string {
  return LABELS[service];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The page Google's redirect lands on.
 *
 * A page rather than JSON, because this is the one route in Helix a human
 * arrives at by being sent there rather than by asking for it, and being
 * dropped on a wall of JSON after granting access reads as a failure even
 * when it worked.
 *
 * Self-contained: it links the stylesheet, but a browser that cannot reach it
 * still gets a readable page.
 */
export function relayPage(options: {
  readonly ok: boolean;
  readonly title: string;
  readonly detail: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Helix — ${escapeHtml(options.title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/helix.css" />
</head>
<body style="display:grid;place-items:center;min-height:100vh;padding:2rem;">
  <main class="hx-panel" style="max-width:34rem;">
    <p class="hx-label">${options.ok ? 'Connected' : 'Not connected'}</p>
    <h1 style="margin:0 0 1rem;font-size:1.1rem;font-weight:400;letter-spacing:0.08em;">${escapeHtml(
      options.title
    )}</h1>
    <p style="margin:0 0 1.75rem;color:var(--hx-text-dim);font-size:0.86rem;line-height:1.7;">${escapeHtml(
      options.detail
    )}</p>
    <a class="hx-btn" href="/" style="text-decoration:none;">Back to Helix</a>
  </main>
</body>
</html>`;
}
