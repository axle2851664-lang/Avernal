import express from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GmailSync, type Email } from '../integrations/gmail.js';
import { YouTubeSync, type Video } from '../integrations/youtube.js';
import { generateImage, generateVideo } from '../integrations/generators.js';
import { ElevenLabsVoice, VoiceError, MAX_AUDIO_BYTES } from '../integrations/elevenlabs.js';
import { SettingsError, SettingsFile } from './settings.js';
import {
  BUNDLE_CHOICES,
  BundleError,
  NEVER_INCLUDED,
  buildBundle,
  choiceFor,
} from './export-bundle.js';
import { WEB_ADDENDUM, webTriggerFor } from '../core/brain/web.js';
import { notepadIntent } from '../core/brain/notepad-intent.js';
import { HelixMind, MindError, type Exchange } from '../integrations/claude.js';
import { SYSTEM_PROMPT, renderNotesContext } from '../core/galaxy/persona.js';
import { GROUNDING_THRESHOLD, groundedNotes } from '../core/galaxy/retrieval.js';
import { TokenStore } from './token-store.js';
import { isLoopback, requireToken } from './auth.js';
import {
  createState,
  explainGoogleError,
  isRelayService,
  relayPage,
  RELAY_SERVICES,
  serviceLabel,
  verifyState,
  type RelayService,
} from './oauth-relay.js';
import { draftCapture } from '../core/galaxy/capture.js';
import { buildGalaxy } from '../core/galaxy/graph.js';
import {
  buildContext,
  capturesFrom,
  ConversationLog,
  describeState,
  MemoryRefused,
  MemoryStore,
  planRequest,
  REPLAY_DEPTH,
  MEMORY_CATEGORIES,
  type MemoryCategory,
} from '../core/brain/index.js';
import {
  NotepadError,
  existingCaptureSlugs,
  listNotes,
  readNote,
  removeNote,
  scanVault,
  searchNotes,
  updateNote,
  writeCapture,
} from '../platform/vault/index.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// The Helix Galaxy UI is served from a different origin than this server, so the
// browser demands CORS headers before it will hand over a response. Origins are
// allowlisted rather than reflected: this process holds Gmail and YouTube access
// tokens, and echoing any origin back would let every site the user visits read
// their mail through localhost.
const DEFAULT_ALLOWED_ORIGINS = ['https://claude.ai', 'https://www.claude.ai'];
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
);

app.use((req: Request, res: Response, next: () => void) => {
  const origin = req.headers.origin;

  if (origin !== undefined && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Chrome treats https -> localhost as a private-network request and blocks
    // it unless the preflight is answered with this.
    if (req.headers['access-control-request-private-network'] === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
  } else if (origin !== undefined) {
    // Printed so an unexpected UI origin is diagnosable from the console rather
    // than surfacing in the browser as an unexplained "failed to fetch".
    console.warn(
      `Blocked cross-origin request from ${origin}. ` +
        `To allow it: ALLOWED_ORIGINS="${origin}" npm run server`
    );
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// The compiled server lives in dist/server, so the package root is two up.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Everything the app accumulates -- tokens, model weights, generated files, the
// vault -- hangs off one root so the whole thing can live on a USB drive and
// still find its data on another machine.
const DATA_ROOT = process.env.HELIX_DATA ?? packageRoot;
const VAULT_ROOT = process.env.HELIX_VAULT ?? join(DATA_ROOT, 'vault');

function isPrivateNetwork(ip: string): boolean {
  // RFC1918 private ranges
  if (/^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^192\.168\./.test(ip)) return true;
  // Link-local (169.254.x.x)
  if (/^169\.254\./.test(ip)) return true;
  // IPv6 unique-local (fc00::/7)
  if (/^fc|^fd/.test(ip)) return true;
  // CGNAT (100.64.0.0/10)
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(ip)) return true;
  // Localhost
  if (/^127\./.test(ip) || ip === '::1' || ip === 'localhost') return true;
  return false;
}

/**
 * Where Google should send them back.
 *
 * Derived from the request rather than fixed at startup, because there is no
 * one right answer: on this machine Helix is localhost, from a phone over
 * Tailscale it is a .ts.net name, and the redirect_uri Google is given has to
 * be the one the person is actually using or the callback lands nowhere.
 * Both need registering in the Google console; whichever started the flow is
 * the one sent.
 *
 * An explicitly configured URL always wins, so anyone who needs an exact
 * value can still pin it.
 */
function callbackUrl(req: Request, service: RelayService): string {
  const configured = (process.env[service.toUpperCase() + '_REDIRECT_URL'] ?? '').trim();
  if (configured !== '') return configured;

  const host = req.get('host') ?? '';
  // The Host header is the caller's to set, and this value ends up in a URL
  // Google is told to send an authorisation code to. Google will only accept
  // a redirect_uri already registered in the project, so the reach is small
  // either way — but a header nobody checked is not where to find that out.
  if (!reachableHost(host)) {
    return 'http://localhost:' + PORT + '/auth/' + service + '/callback';
  }
  return forwardedProtocol(req) + '://' + host + '/auth/' + service + '/callback';
}

/** Hosts Helix could plausibly be reached on: this machine, or your tailnet. */
function reachableHost(host: string): boolean {
  const name = (host.split(':')[0] ?? '').toLowerCase();
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]') return true;
  if (name.endsWith('.ts.net')) return true;
  if (/^10\./.test(name) || /^192\.168\./.test(name)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(name)) return true;
  // Tailscale's own range.
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(name)) return true;
  return false;
}

/**
 * http or https, accounting for a local TLS terminator.
 *
 * `tailscale serve` holds the certificate and forwards plain HTTP to this
 * process, so req.protocol says http and the redirect_uri would come out
 * wrong — Google would reject it as unregistered. The forwarded header says
 * otherwise, and is trusted only from a loopback peer: from anywhere else it
 * is just something the caller typed. Express's own `trust proxy` is not used
 * because it would also make req.ip follow X-Forwarded-For, and that is what
 * the private-network check reads.
 */
function forwardedProtocol(req: Request): string {
  const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (peer === '127.0.0.1' || peer === '::1') {
    const header = req.headers['x-forwarded-proto'];
    const first = (Array.isArray(header) ? header[0] : header) ?? '';
    const proto = (first.split(',')[0] ?? '').trim().toLowerCase();
    if (proto === 'https' || proto === 'http') return proto;
  }
  return req.protocol;
}

function googleConfig(service: RelayService): { clientId: string; clientSecret: string; redirectUrl: string } {
  const prefix = service.toUpperCase();
  return {
    clientId: process.env[prefix + '_CLIENT_ID'] ?? '',
    clientSecret: process.env[prefix + '_CLIENT_SECRET'] ?? '',
    // A placeholder: every call that matters passes the real one per request.
    redirectUrl: process.env[prefix + '_REDIRECT_URL'] ?? '',
  };
}

const gmailSync = new GmailSync(googleConfig('gmail'));
const youtubeSync = new YouTubeSync(googleConfig('youtube'));

// Backed by a file so a restart does not silently drop every connection.
const tokenStore = new TokenStore(DATA_ROOT);

// Persist tokens the library renews on its own, so a refresh outlives the
// process that performed it.
for (const [service, sync] of [
  ['gmail', gmailSync],
  ['youtube', youtubeSync],
] as const) {
  sync.onTokenRefresh((accessToken, refreshToken, expiresAt) => {
    const existing = tokenStore.get(service);
    tokenStore.set(service, {
      accessToken,
      // A refresh response usually omits the refresh token; keep the stored one.
      refreshToken: refreshToken ?? existing?.refreshToken ?? null,
      expiresAt: expiresAt ?? Date.now() + 3600000,
    });
    console.log(`Refreshed ${service} access token.`);
  });
}

const HOST = process.env.HOST ?? '127.0.0.1';
const HELIX_TOKEN = process.env.HELIX_TOKEN ?? '';

// Listening beyond loopback means another device can reach the Gmail and
// YouTube tokens this process holds, so a shared secret becomes mandatory
// rather than optional. Refusing to boot is deliberate: the alternative is an
// unauthenticated inbox reachable from the network.
if (!isLoopback(HOST) && HELIX_TOKEN === '') {
  console.error(
    `Refusing to listen on ${HOST} without a token.\n` +
      `Anyone able to reach this port could read your mail.\n\n` +
      `  HELIX_TOKEN=$(openssl rand -hex 24) HOST=${HOST} npm run server\n`
  );
  process.exit(1);
}

if (HELIX_TOKEN !== '') {
  app.use(requireToken(HELIX_TOKEN));
}

// Middleware: verify private network access
app.use((_req: Request, res: Response, next: () => void) => {
  const clientIp = (_req.ip || _req.socket.remoteAddress || '').toString();
  if (!isPrivateNetwork(clientIp)) {
    return res.status(403).json({ error: 'Access denied: not on private network' });
  }
  next();
});

// Registered after the private-network check so static files are gated by it
// too. Serving the UI from this same origin is what makes the generator usable
// without CORS at all: open http://localhost:3000 and the page and the API
// agree on an origin. The generated files must be served as well, or a result
// is only ever a path the browser cannot load.
app.use(express.static(join(packageRoot, 'public')));
app.use('/generated_images', express.static(join(DATA_ROOT, 'generated_images')));
app.use('/generated_videos', express.static(join(DATA_ROOT, 'generated_videos')));

/* ------------------------------------------------------------ Google relay */

/*
 * Connecting a Google account.
 *
 * Helix never sees a Google password: it sends the user to Google, Google
 * asks them, and the code Google hands back is exchanged here for tokens.
 *
 * Both services run the same three steps, so they share one set of routes
 * rather than two copies that drift. The scopes are read-only and live with
 * each integration — Helix reads mail and videos, and has no way to send,
 * delete or modify anything.
 */
const relays: Readonly<Record<RelayService, { readonly getAuthUrl: (redirectUrl: string) => string; readonly exchange: (code: string, redirectUrl: string) => Promise<{ access_token?: string | null | undefined; refresh_token?: string | null | undefined; expiry_date?: number | null | undefined }>; readonly configured: () => boolean }>> = {
  gmail: {
    getAuthUrl: (redirectUrl) => gmailSync.getAuthUrl(undefined, redirectUrl),
    exchange: (code, redirectUrl) => gmailSync.setCredentials(code, redirectUrl),
    configured: () => gmailSync.configured,
  },
  youtube: {
    getAuthUrl: (redirectUrl) => youtubeSync.getAuthUrl(undefined, redirectUrl),
    exchange: (code, redirectUrl) => youtubeSync.setCredentials(code, redirectUrl),
    configured: () => youtubeSync.configured,
  },
};

/*
 * The secret that signs the `state` on the round trip.
 *
 * The shared token when there is one, so it survives a restart and a browser
 * that was mid-flow still lands. Otherwise a per-process value: on loopback
 * there is nobody else to forge one, and a restart invalidating an in-flight
 * sign-in only costs a retry.
 */
const RELAY_SECRET = HELIX_TOKEN !== '' ? HELIX_TOKEN : randomUUID();

/**
 * Step one: send them to Google.
 *
 * A redirect, so the link can simply be clicked. `?json=1` returns the URL
 * instead, which is what the command console uses — it shows the link rather
 * than following it, because that decision is the user's.
 */
app.get('/auth/:service/start', (req: Request, res: Response) => {
  const service = req.params.service;
  if (!isRelayService(service)) {
    return res.status(404).json({ error: 'Helix does not connect that service' });
  }

  // Said here rather than by Google, which answers a missing client id with
  // a page about an invalid request that names nothing you can act on.
  if (!relays[service].configured()) {
    const missing = service.toUpperCase();
    const message =
      'Set ' + missing + '_CLIENT_ID and ' + missing + '_CLIENT_SECRET first — Ctrl K, SETTINGS.';
    if (req.query.json === '1' || req.get('accept')?.includes('application/json') === true) {
      return res.status(503).json({ error: message });
    }
    return res.status(503).send(message);
  }

  const url = new URL(relays[service].getAuthUrl(callbackUrl(req, service)));
  url.searchParams.set('state', createState(service, RELAY_SECRET));
  const authUrl = url.toString();

  if (req.query.json === '1' || req.get('accept')?.includes('application/json') === true) {
    return res.json({ authUrl });
  }
  res.redirect(authUrl);
});

/**
 * Step two: Google sends them back here.
 *
 * This is the one route in Helix a person arrives at by being sent, so it
 * answers with a page rather than JSON. A wall of JSON after granting access
 * reads as a failure even when it worked.
 */
app.get('/auth/:service/callback', async (req: Request, res: Response) => {
  const service = req.params.service;
  if (!isRelayService(service)) {
    return res.status(404).send(relayPage({
      ok: false,
      title: 'Unknown service',
      detail: 'Helix connects Gmail and YouTube. That was neither.',
    }));
  }

  const label = serviceLabel(service);

  // Google reports a refusal by redirecting here with an error rather than by
  // failing the request, so this has to be checked before anything else.
  if (typeof req.query.error === 'string') {
    return res.status(400).send(relayPage({
      ok: false,
      title: label + ' was not connected',
      detail: explainGoogleError(req.query.error),
    }));
  }

  const check = verifyState(req.query.state, service, RELAY_SECRET);
  if (!check.ok) {
    return res.status(400).send(relayPage({
      ok: false,
      title: label + ' was not connected',
      detail: check.reason,
    }));
  }

  const code = req.query.code;
  if (typeof code !== 'string' || code === '') {
    return res.status(400).send(relayPage({
      ok: false,
      title: label + ' was not connected',
      detail: 'Google did not send an authorisation code back.',
    }));
  }

  try {
    // The same URL the flow was started with — Google compares them byte for
    // byte, and this request arrived at that very origin, so deriving it the
    // same way gives the same answer.
    const tokens = await relays[service].exchange(code, callbackUrl(req, service));
    const refreshToken = tokens.refresh_token ?? null;

    tokenStore.set(service, {
      accessToken: tokens.access_token ?? '',
      refreshToken,
      expiresAt: tokens.expiry_date ?? Date.now() + 3600000,
    });

    res.send(relayPage({
      ok: true,
      title: label + ' is connected',
      detail:
        refreshToken === null
          ? 'Connected, but Google did not issue a refresh token, so this will stop working in an hour. Remove Helix at myaccount.google.com under Data & privacy, Third-party access, then connect again.'
          : 'Helix can read your ' + label + '. It cannot send, delete or change anything.',
    }));
  } catch (error) {
    // The library wraps Google's code; surface it when it is there rather
    // than the stack, which says nothing about what to fix.
    const raw = String((error as { message?: unknown }).message ?? error);
    const known = /invalid_grant|invalid_client|redirect_uri_mismatch|invalid_scope/.exec(raw);
    res.status(502).send(relayPage({
      ok: false,
      title: label + ' was not connected',
      detail: known === null ? 'Google would not exchange the code.' : explainGoogleError(known[0]),
    }));
  }
});

/** What is connected, without saying anything about the tokens themselves. */
app.get('/auth/status', (req: Request, res: Response) => {
  res.json({
    services: RELAY_SERVICES.map((service) => ({
      service,
      label: serviceLabel(service),
      connected: tokenStore.has(service),
      // Whether Helix has a client at all, which is a different question from
      // whether it has been authorised with one.
      configured: relays[service].configured(),
      start: '/auth/' + service + '/start',
      // What to paste into the Google console for this origin. Getting it
      // wrong is the single commonest way this flow fails, and Google's error
      // page does not tell you what it expected.
      callback: callbackUrl(req, service),
    })),
  });
});

/**
 * Forget a connection.
 *
 * Local only: it drops the tokens Helix holds. The grant itself lives in the
 * Google account and is revoked at myaccount.google.com — saying otherwise
 * would be claiming a reach Helix does not have.
 */
app.post('/auth/:service/disconnect', (req: Request, res: Response) => {
  const service = req.params.service;
  if (!isRelayService(service)) {
    return res.status(404).json({ error: 'Helix does not connect that service' });
  }

  const had = tokenStore.has(service);
  tokenStore.clear(service);
  res.json({
    success: true,
    forgotten: had,
    note: 'Helix has dropped its copy. To revoke the grant itself, remove Helix at myaccount.google.com under Data & privacy, Third-party access.',
  });
});

// Convert email to note format
function emailToNote(email: Email): { title: string; content: string; tags: string[] } {
  const fromParts = email.from.split('<');
  const from = (fromParts[0] ?? '').trim() || 'Unknown';
  const title = `Email from ${from}: ${email.subject.substring(0, 50)}`;
  const content = `
**From:** ${email.from}
**To:** ${email.to}
**Subject:** ${email.subject}
**Date:** ${new Date(email.timestamp).toLocaleString()}

---

${email.body}

${email.snippet ? `\n**Preview:** ${email.snippet}` : ''}
`.trim();

  return {
    title,
    content,
    tags: ['email', ...email.labels.map((l) => `label:${l}`)],
  };
}

// Fetch and sync emails
app.post('/sync/gmail/unread', async (_req: Request, res: Response) => {
  const tokenData = tokenStore.get('gmail');
  if (!tokenData) {
    return res.status(401).json({ error: 'Gmail not authenticated. Run /auth/gmail/start first' });
  }

  try {
    await gmailSync.setAccessToken(tokenData.accessToken, tokenData.refreshToken, tokenData.expiresAt);
    const emails = await gmailSync.fetchUnread();
    const notes = emails.map(emailToNote);
    res.json({ success: true, count: notes.length, notes });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch emails', details: String(error) });
  }
});

// Fetch emails from specific sender
app.post('/sync/gmail/from/:sender', async (req: Request, res: Response) => {
  const senderParam = req.params.sender;
  const sender = Array.isArray(senderParam) ? (senderParam[0] ?? '') : (senderParam ?? '');
  const tokenData = tokenStore.get('gmail');
  if (!tokenData) {
    return res.status(401).json({ error: 'Gmail not authenticated' });
  }

  try {
    await gmailSync.setAccessToken(tokenData.accessToken, tokenData.refreshToken, tokenData.expiresAt);
    const emails = await gmailSync.fetchFromSender(sender);
    const notes = emails.map(emailToNote);
    res.json({ success: true, count: notes.length, notes });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch emails', details: String(error) });
  }
});

// Convert video to note format
function videoToNote(video: Video): { title: string; content: string; tags: string[] } {
  const title = `[${video.viewCount} views] ${video.title.substring(0, 60)}`;
  const content = `
**Channel:** ${video.channelTitle}
**Published:** ${video.publishedAt}
**Views:** ${video.viewCount} | **Likes:** ${video.likeCount} | **Comments:** ${video.commentCount}

---

${video.description.substring(0, 1000)}${video.description.length > 1000 ? '…' : ''}

**Video ID:** ${video.id}
`.trim();

  return {
    title,
    content,
    tags: ['youtube', 'video'],
  };
}

// YouTube OAuth flow start
// Fetch and sync YouTube videos
app.post('/sync/youtube/videos', async (_req: Request, res: Response) => {
  const tokenData = tokenStore.get('youtube');
  if (!tokenData) {
    return res
      .status(401)
      .json({ error: 'YouTube not authenticated. Open /auth/youtube/start first' });
  }

  try {
    await youtubeSync.setAccessToken(tokenData.accessToken, tokenData.refreshToken, tokenData.expiresAt);
    const videos = await youtubeSync.fetchChannelVideos(15);
    const notes = videos.map(videoToNote);
    res.json({ success: true, count: notes.length, notes });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch videos', details: String(error) });
  }
});

// Generate image from text prompt
app.post('/generate/image', async (req: Request, res: Response) => {
  try {
    const { prompt, steps = 20, guidance = 7.5, seed } = req.body as {
      prompt?: string;
      steps?: number;
      guidance?: number;
      seed?: number;
    };

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid prompt' });
    }

    const result = await generateImage(
      prompt,
      steps,
      guidance,
      seed ?? Math.floor(Math.random() * 1000000)
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate image', details: String(error) });
  }
});

// Generate video from text prompt
app.post('/generate/video', async (req: Request, res: Response) => {
  try {
    const { prompt, frames = 8, steps = 25, seed } = req.body as {
      prompt?: string;
      frames?: number;
      steps?: number;
      seed?: number;
    };

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid prompt' });
    }

    const result = await generateVideo(
      prompt,
      frames,
      steps,
      seed ?? Math.floor(Math.random() * 1000000)
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate video', details: String(error) });
  }
});

/**
 * Writes text into the vault as a note. Shared by the note box in the UI and by
 * anything forwarding messages in, so both go through the vault's own draft and
 * write path -- including its refusal to write outside the vault.
 */
async function saveNote(text: string, origin: string): Promise<{ title: string; path: string }> {
  // Title from the message alone: drafting from text with the attribution
  // already appended pulls "(via" into the title, since it is taken from the
  // opening words.
  const draft = draftCapture(text, { taken: await existingCaptureSlugs(VAULT_ROOT) });
  const withOrigin =
    origin === '' ? draft : { ...draft, markdown: `${draft.markdown}\n(via ${origin})\n` };

  const path = await writeCapture(VAULT_ROOT, withOrigin);
  return { title: draft.title, path };
}

// Add a note by hand.
/* -------------------------------------------------------------- export */

/*
 * Taking Helix's own data off the machine.
 *
 * No drive detection, because there is none to be had: a page cannot see a
 * USB stick and this server cannot see one plugged into the phone talking to
 * it. What it does is hand back a bundle the browser downloads, which you put
 * wherever you like — a flash drive included.
 *
 * Secrets cannot reach it by construction: buildBundle is pure and is handed
 * notes, memories and turns. It is never given a key, so it cannot pack one.
 */
app.get('/export/options', (_req: Request, res: Response) => {
  res.json({ choices: BUNDLE_CHOICES, never: NEVER_INCLUDED });
});

app.post('/export', async (req: Request, res: Response) => {
  let choice;
  try {
    choice = choiceFor((req.body as { choice?: unknown })?.choice);
  } catch (error) {
    return res.status(400).json({ error: (error as BundleError).message });
  }

  try {
    const notes = choice.parts.includes('notepad')
      ? await Promise.all(
          (await listNotes(VAULT_ROOT)).map((note) => readNote(VAULT_ROOT, note.id))
        )
      : [];

    const bundle = buildBundle(
      choice,
      {
        notes,
        memories: choice.parts.includes('memory') ? memory.all() : [],
        turns: choice.parts.includes('conversation')
          ? conversation.all().map((turn) => ({
              question: turn.question,
              answer: turn.answer,
              at: turn.at,
            }))
          : [],
      },
      new Date()
    );

    res.json({ choice: bundle.choice, counts: bundle.counts, files: bundle.files });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // No vault yet. An empty export is the truthful answer, not a failure.
      const bundle = buildBundle(choice, { notes: [], memories: [], turns: [] }, new Date());
      return res.json({ choice: bundle.choice, counts: bundle.counts, files: bundle.files });
    }
    console.error('Export failed:', error);
    res.status(500).json({ error: 'The export could not be built.' });
  }
});

/* ------------------------------------------------------------- notepad */

/*
 * The notepad is the vault.
 *
 * These four routes are list, read, change and delete over the notes already
 * on disk — the ones POST /notes writes, the galaxy draws, and /ask answers
 * from. A notepad with a store of its own would be a second copy of the same
 * notes, and whichever Helix answered from would be whichever was written to
 * last.
 */
function sendNotepadError(res: Response, error: unknown): void {
  if (error instanceof NotepadError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  // Not passed through: an fs error carries the vault's path.
  console.error('Notepad failed:', error);
  res.status(500).json({ error: 'The notepad could not be read.' });
}

/** Every note, or the ones matching ?q=. Metadata only — never every body. */
app.get('/notepad', async (req: Request, res: Response) => {
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  try {
    const notes = query.trim() === '' ? await listNotes(VAULT_ROOT) : await searchNotes(VAULT_ROOT, query);
    res.json({ notes, query: query.trim() });
  } catch (error) {
    // An absent vault is an empty notepad, not a failure: it is what a first
    // run looks like.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return res.json({ notes: [], query: query.trim() });
    }
    sendNotepadError(res, error);
  }
});

/*
 * One note, in full.
 *
 * The id is a vault-relative path, so it is taken from the query string
 * rather than the URL path — Express would otherwise split it on its own
 * slashes and hand back only the last segment.
 */
app.get('/notepad/note', async (req: Request, res: Response) => {
  try {
    res.json(await readNote(VAULT_ROOT, req.query.id));
  } catch (error) {
    sendNotepadError(res, error);
  }
});

app.patch('/notepad/note', async (req: Request, res: Response) => {
  const body = req.body as { id?: unknown; title?: unknown; content?: unknown; tags?: unknown };
  const patch: { title?: string; content?: string; tags?: string[] } = {};
  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.content === 'string') patch.content = body.content;
  if (Array.isArray(body.tags)) patch.tags = body.tags.map((tag) => String(tag));

  try {
    res.json(await updateNote(VAULT_ROOT, body.id, patch));
  } catch (error) {
    sendNotepadError(res, error);
  }
});

app.delete('/notepad/note', async (req: Request, res: Response) => {
  try {
    const gone = await removeNote(VAULT_ROOT, (req.body as { id?: unknown })?.id ?? req.query.id);
    res.json({ deleted: true, note: gone });
  } catch (error) {
    sendNotepadError(res, error);
  }
});

app.post('/notes', async (req: Request, res: Response) => {
  const { text } = req.body as { text?: string };
  if (typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'Missing text' });
  }

  try {
    res.json({ success: true, ...(await saveNote(text, '')) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save note', details: String(error) });
  }
});

/**
 * Somewhere for a phone to send a message. iOS gives no app access to SMS, so
 * the only route on an iPhone is a Shortcuts automation posting here; keeping
 * the endpoint generic means a Mac bridge or an Android forwarder can use it
 * unchanged.
 */
app.post('/ingest/message', async (req: Request, res: Response) => {
  const { text, from, source } = req.body as {
    text?: string;
    from?: string;
    source?: string;
  };

  if (typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'Missing text' });
  }

  try {
    const origin = [source, from].filter((v) => typeof v === 'string' && v !== '').join(' from ');
    res.json({ success: true, ...(await saveNote(text, origin)) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save message', details: String(error) });
  }
});

/**
 * The galaxy as the UI needs to draw it.
 *
 * Read-only, and a projection rather than a dump: labels, groups and edges go
 * out, note bodies and excerpts do not. The visualisation has no use for the
 * text, and this endpoint is reachable from every device on the private
 * network, so the less of the vault it hands over the better.
 *
 * An empty vault is not an error. A first run has no notes yet, and the UI has
 * to be able to say so rather than show a failure.
 */
app.get('/galaxy', async (_req: Request, res: Response) => {
  try {
    const notes = await scanVault(VAULT_ROOT).catch((error: NodeJS.ErrnoException) => {
      // The vault directory is created on first write, so its absence before
      // then is the normal state, not a fault.
      if (error.code === 'ENOENT') return [];
      throw error;
    });

    const galaxy = buildGalaxy(notes);
    const groups = [...new Set(galaxy.nodes.map((node) => node.group))].sort();

    res.json({
      nodes: galaxy.nodes.map((node) => ({ id: node.id, label: node.label, group: node.group })),
      links: galaxy.links,
      groups,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read the galaxy', details: String(error) });
  }
});

/* ------------------------------------------------------------------ voice */

/*
 * Speech through ElevenLabs.
 *
 * The key is read from the environment once, here, and lives only inside this
 * object. No route returns it, no error carries it, and nothing writes it
 * down — the memory layer refuses key-shaped text for the same reason. To give
 * Helix a voice:
 *
 *   ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... npm run server
 */
// Not const: the settings screen can replace it with one built from a key
// that was not there when the process started. Rebuilt rather than mutated,
// because the key is private to the instance and that is the point of it.
let voice = ElevenLabsVoice.fromEnvironment();

function sendVoiceError(res: Response, error: unknown): void {
  if (error instanceof VoiceError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  // Anything unexpected is reported without its detail: an unhandled error
  // from an HTTP client is exactly the kind that quotes the request back.
  console.error('Voice failed:', error);
  res.status(500).json({ error: 'Speech failed.' });
}

/* --------------------------------------------------------------- settings */

/*
 * Where the keys are kept.
 *
 * Beside the package, as a 0600 .env — the same file the setup docs tell you
 * to write by hand, so the screen and the documentation cannot disagree about
 * where a key lives.
 */
const settings = new SettingsFile(DATA_ROOT);

/**
 * What is configured. Never a value — see settings.ts for why that matters.
 */
app.get('/settings', (_req: Request, res: Response) => {
  res.json({ path: settings.path, settings: settings.state() });
});

/*
 * Save keys.
 *
 * The clients that read a key at construction are rebuilt here, so a key
 * pasted in works on the next question rather than the next restart. The
 * Google clients are not: swapping an OAuth client under tokens that were
 * issued to the previous one is precisely the moment you want a clean start,
 * so those are saved and reported as needing one.
 */
app.post('/settings', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Send an object of settings.' });
  }

  let saved: readonly string[];
  try {
    saved = settings.save(body);
  } catch (error) {
    if (error instanceof SettingsError) {
      return res.status(error.status).json({ error: error.message });
    }
    // Never passed through: an fs error carries the path of the key file.
    console.error('Could not save settings:', error);
    return res.status(500).json({ error: 'Could not save the settings.' });
  }

  if (saved.some((key) => key.startsWith('ELEVENLABS_'))) {
    voice = ElevenLabsVoice.fromEnvironment();
  }
  if (saved.includes('ANTHROPIC_API_KEY')) {
    mind = HelixMind.fromEnvironment();
  }

  /*
   * The Google clients too, now that they can be rebuilt in place.
   *
   * Any tokens held were issued to the previous OAuth client and are not
   * valid for a new one, so they are dropped and the connection has to be
   * made again. Keeping them would present later as an authorisation that
   * mysteriously stopped working, which is worse than being told plainly.
   */
  const reconnect: string[] = [];
  for (const service of RELAY_SERVICES) {
    const prefix = service.toUpperCase() + '_';
    if (!saved.some((key) => key.startsWith(prefix))) continue;

    const sync = service === 'gmail' ? gmailSync : youtubeSync;
    sync.reconfigure(googleConfig(service));
    if (tokenStore.has(service)) {
      tokenStore.clear(service);
      reconnect.push(serviceLabel(service));
    }
  }

  res.json({
    saved,
    // Nothing needs a restart any more. What may need doing is connecting a
    // Google account again, and only when one was already connected.
    reconnect,
    settings: settings.state(),
  });
});

/**
 * Whether Helix can speak and hear, and what to set if he cannot. Never the
 * key. `canHear` is reported separately because listening needs only the key:
 * someone who has not chosen a voice can still talk to Helix.
 */
app.get('/voice/status', (_req: Request, res: Response) => {
  res.json(voice.status());
});

app.get('/voice/voices', async (_req: Request, res: Response) => {
  try {
    res.json({ voices: await voice.voices() });
  } catch (error) {
    sendVoiceError(res, error);
  }
});

/*
 * Listen.
 *
 * The clip arrives as a raw body rather than a multipart upload: the browser
 * hands the recorder's Blob straight to fetch, there is exactly one field, and
 * a multipart parser here would be a dependency and a parser to be wrong
 * about for no gain. The Content-Type is whatever the browser's recorder
 * produced — webm/opus on Chrome, mp4 on Safari — and is passed through, since
 * guessing it for the service would only make Helix deaf on one browser.
 *
 * Nothing is written to disk. The clip exists for the length of the request.
 */
app.post(
  '/voice/listen',
  express.raw({ type: ['audio/*', 'video/*'], limit: MAX_AUDIO_BYTES }),
  async (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No audio arrived. Send the recording as the body.' });
    }

    const contentType = (req.headers['content-type'] ?? 'audio/webm').split(';')[0] ?? 'audio/webm';
    // The service reads the container from the filename as well as the type,
    // so the extension has to follow the one the browser actually recorded.
    const extension = contentType.includes('mp4')
      ? 'mp4'
      : contentType.includes('ogg')
        ? 'ogg'
        : contentType.includes('wav')
          ? 'wav'
          : 'webm';

    try {
      const heard = await voice.transcribe(req.body, 'speech.' + extension, contentType);
      res.json({ text: heard.text, language: heard.language });
    } catch (error) {
      sendVoiceError(res, error);
    }
  }
);

/*
 * Speak a line. The audio comes back as the response body rather than a file
 * on disk: this is a spoken reply, not an artefact, and writing every one of
 * them into the data root would accumulate a transcript nobody asked for.
 */
app.post('/voice/speak', async (req: Request, res: Response) => {
  const { text } = req.body as { text?: string };
  if (typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing text' });
  }

  try {
    const speech = await voice.speak(text);
    res.setHeader('Content-Type', speech.contentType);
    res.setHeader('Content-Length', String(speech.audio.length));
    // Spoken lines are one-offs; a cached one would be the wrong joke later.
    res.setHeader('Cache-Control', 'no-store');
    res.send(speech.audio);
  } catch (error) {
    sendVoiceError(res, error);
  }
});

/* ------------------------------------------------------------------ brain */

/*
 * The intelligence layer, exposed so the UI can show and manage what Helix
 * remembers. Reads are plain GETs; anything that writes says what it did and
 * why it refused when it refuses.
 *
 * These sit behind the same token and private-network checks as everything
 * else on this server, because memory is at least as personal as mail.
 */

// One store for the process, beside the vault under the same data root, so it
// travels with everything else Helix accumulates.
const memory = new MemoryStore(DATA_ROOT);

// The session this server process represents. Short-term memory is scoped to
// it, so restarting Helix clears the short-term layer and nothing else.
const SESSION_ID = randomUUID();
const SESSION_STARTED_AT = new Date().toISOString();
let currentProjectId: string | null = null;

function isCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

/** Turns a refusal into a 422 and anything else into a 500. */
function sendMemoryError(res: Response, error: unknown): void {
  if (error instanceof MemoryRefused) {
    res.status(422).json({ error: error.message, refused: true });
    return;
  }
  res.status(500).json({ error: 'Memory operation failed', details: String(error) });
}

app.get('/brain/state', (_req: Request, res: Response) => {
  res.json(
    describeState(memory, {
      sessionId: SESSION_ID,
      startedAt: SESSION_STARTED_AT,
      currentProjectId,
      plan: null,
    }, conversation)
  );
});

app.get('/brain/memory', (req: Request, res: Response) => {
  const category = req.query.category;
  if (category !== undefined && !isCategory(category)) {
    return res.status(400).json({ error: 'Unknown memory category' });
  }

  res.json({
    memories: memory.search({
      ...(isCategory(category) ? { category } : {}),
      ...(typeof req.query.project === 'string' ? { projectId: req.query.project } : {}),
      ...(typeof req.query.q === 'string' ? { text: req.query.q } : {}),
    }),
    counts: memory.counts(),
  });
});

app.post('/brain/memory', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  if (!isCategory(body.category)) {
    return res.status(400).json({ error: 'A memory needs one of: ' + MEMORY_CATEGORIES.join(', ') });
  }
  if (typeof body.text !== 'string' || typeof body.reason !== 'string') {
    return res.status(400).json({ error: 'A memory needs text and a reason' });
  }

  try {
    // Anything arriving over HTTP was asked for by whoever sent it. Helix does
    // not get to claim an observation and bypass the rule that keeps
    // unrequested things out of durable memory.
    res.json({
      success: true,
      memory: memory.remember({
        category: body.category,
        text: body.text,
        reason: body.reason,
        source: { origin: 'user-command', detail: 'brain API' },
        projectId: typeof body.projectId === 'string' ? body.projectId : null,
        sessionId: body.category === 'short-term' ? SESSION_ID : null,
        tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : [],
      }),
    });
  } catch (error) {
    sendMemoryError(res, error);
  }
});

app.patch('/brain/memory/:id', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const id = String(req.params.id ?? '');

  try {
    res.json({
      success: true,
      memory: memory.edit(id, {
        ...(typeof body.text === 'string' ? { text: body.text } : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        ...(isCategory(body.category) ? { category: body.category } : {}),
        ...(typeof body.projectId === 'string' || body.projectId === null
          ? { projectId: body.projectId as string | null }
          : {}),
        ...(typeof body.taskState === 'string'
          ? { taskState: body.taskState as 'open' | 'blocked' | 'done' | 'abandoned' }
          : {}),
      }),
    });
  } catch (error) {
    sendMemoryError(res, error);
  }
});

app.delete('/brain/memory/:id', (req: Request, res: Response) => {
  const removed = memory.forget(String(req.params.id ?? ''));
  if (!removed) return res.status(404).json({ error: 'No memory with that id' });
  res.json({ success: true });
});

/*
 * Clearing memory. The category has to be named explicitly, and clearing
 * everything needs `all: true` rather than an omitted field: forgetting the
 * lot should not be what happens when a parameter goes missing.
 */
app.post('/brain/memory/clear', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  if (body.all === true) {
    return res.json({ success: true, removed: memory.clear(), scope: 'all' });
  }
  if (!isCategory(body.category)) {
    return res
      .status(400)
      .json({ error: 'Name a category to clear, or pass all: true to clear everything' });
  }
  res.json({ success: true, removed: memory.clear(body.category), scope: body.category });
});

/* ----------------------------------------------------- the conversation */

app.get('/brain/conversation', (req: Request, res: Response) => {
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  res.json({
    turns: conversation.search(query),
    total: conversation.size,
    sessions: conversation.sessions,
  });
});

app.delete('/brain/conversation/:id', (req: Request, res: Response) => {
  if (!conversation.forget(String(req.params.id ?? ''))) {
    return res.status(404).json({ error: 'No turn with that id' });
  }
  res.json({ success: true });
});

/*
 * Forget the whole conversation. `all: true` has to be said, for the same
 * reason clearing memory does: losing every exchange should not be what
 * happens when a parameter goes missing.
 */
app.post('/brain/conversation/clear', (req: Request, res: Response) => {
  if ((req.body as Record<string, unknown>).all !== true) {
    return res.status(400).json({ error: 'Pass all: true to forget the whole conversation' });
  }
  res.json({ success: true, removed: conversation.clear() });
});

app.post('/brain/context', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  if (typeof body.utterance !== 'string') {
    return res.status(400).json({ error: 'Missing utterance' });
  }

  const context = buildContext(memory, body.utterance, {
    sessionId: SESSION_ID,
    currentProjectId,
  });

  // The resolved project becomes current, which is what lets a later bare
  // "continue" mean the same thing this sentence did.
  if (context.projectId !== null) currentProjectId = context.projectId;

  res.json(context);
});

app.post('/brain/plan', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  if (typeof body.request !== 'string') {
    return res.status(400).json({ error: 'Missing request' });
  }

  // Planning only. Nothing here runs a step, and steps that would reach
  // outside this machine come back marked awaiting-confirmation.
  res.json(
    planRequest(body.request, { projects: memory.projects(), currentProjectId })
  );
});

/* -------------------------------------------------------------------- ask */

/*
 * Asking Helix something.
 *
 * This is where the pieces that already existed finally meet. The vault
 * supplies the facts, the brain supplies what it remembers about him, the
 * persona supplies the character, and the model supplies the sentence. None
 * of that judgement lives here — this route is the wire.
 */
// Replaced, not mutated, when a key is saved. See `voice` above.
let mind = HelixMind.fromEnvironment();

/*
 * What has been said, kept beside the vault and the memory.
 *
 * A transcript rather than a memory: a memory is something Helix was asked to
 * keep and can justify keeping, where a turn is just a record of what passed
 * between you. It outlives the process because a conversation that forgets
 * itself whenever the server restarts is not a conversation.
 */
const conversation = new ConversationLog(DATA_ROOT);

app.get('/ask/status', (_req: Request, res: Response) => {
  res.json(mind.status());
});

app.post('/ask', async (req: Request, res: Response) => {
  const { question } = req.body as { question?: string };
  if (typeof question !== 'string' || question.trim() === '') {
    return res.status(400).json({ error: 'Missing question' });
  }

  try {
    /*
     * Anything the sentence asked to be kept, kept first.
     *
     * Before the model, so "Remember this: …" works with no API key at all —
     * writing it down is this server's job, not the model's. Every capture is
     * reported back in the reply: the rule is that Helix does not keep things
     * quietly, and that holds just as much for something you asked for as for
     * something it noticed.
     */
    const remembered: { text: string; category: string; why: string }[] = [];
    const notRemembered: string[] = [];

    for (const capture of capturesFrom(question)) {
      try {
        const saved = memory.remember({
          category: capture.category,
          text: capture.text,
          reason: capture.reason,
          source: { origin: capture.origin, detail: 'said "' + capture.trigger + '"' },
          ...(capture.category === 'short-term' ? { sessionId: SESSION_ID } : {}),
        });
        remembered.push({ text: saved.text, category: saved.category, why: saved.reason });
      } catch (error) {
        // A refusal is the rules working — a credential, or too long. It is
        // said out loud rather than swallowed, and it costs no answer.
        notRemembered.push(error instanceof MemoryRefused ? error.message : 'Could not keep that.');
      }
    }

    /*
     * The notepad, when the words are about notes.
     *
     * Recognised here rather than in the browser so that speaking and typing
     * go through one rule — the microphone posts to this same route, and a
     * second implementation on the client would drift from this one.
     *
     * Only `create` acts. The rest are answered with an intent the screen
     * carries out, because opening a screen is the screen's business, and
     * because a misheard sentence must not be able to delete a note.
     */
    const pad = notepadIntent(question);
    let padSaved: { title: string; path: string } | null = null;

    if (pad !== null && pad.action === 'create' && pad.subject !== '') {
      try {
        const written = await saveNote(pad.subject, '');
        padSaved = { title: written.title, path: written.path };
      } catch (error) {
        console.error('Could not write the note:', error);
      }
    }

    // Facts first: whatever in the vault is actually about this question.
    // groundedNotes returns nothing rather than the best of a bad lot, which
    // is what keeps him from answering confidently out of an unrelated note.
    const notes = await scanVault(VAULT_ROOT).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const galaxy = buildGalaxy(notes);
    let sources = groundedNotes(galaxy, question);

    /*
     * Asked to look through the notes, rather than asked a question.
     *
     * groundedNotes only attaches a note scoring at least a title match, so a
     * word mentioned once in the middle of a long note never reaches the
     * model. That threshold is right for an ordinary question — it is what
     * stops Helix answering confidently out of a note that merely shares a
     * word — but it is wrong when the person has explicitly said "find my
     * note about X", because the whole request is to go looking.
     *
     * So on that intent the notepad's own search runs, which does read
     * bodies, and its hits are added to whatever was already grounded. The
     * threshold is untouched for every other question.
     */
    if (pad !== null && pad.action === 'search' && pad.subject !== '') {
      const found = await searchNotes(VAULT_ROOT, pad.subject).catch(() => []);
      const byKey = new Map(galaxy.nodes.map((node) => [node.key, node.id]));
      const already = new Set(sources.map((source) => source.id));

      const extra = found
        .map((note) => byKey.get(note.id))
        .filter((id): id is number => id !== undefined && !already.has(id))
        .map((id) => ({ id, score: GROUNDING_THRESHOLD }));

      sources = [...sources, ...extra].slice(0, 8);
    }

    const notesBlock = renderNotesContext(galaxy, sources);

    // Then memory: what the brain considers relevant, with the reason it was
    // chosen dropped — the model needs the fact, not the bookkeeping.
    const context = buildContext(memory, question, {
      sessionId: SESSION_ID,
      currentProjectId,
    });
    if (context.projectId !== null) currentProjectId = context.projectId;
    const memoryBlock = context.items.map((item) => '- ' + item.memory.text).join('\n');

    // Earlier turns, from this run of the server and every one before it.
    const history: Exchange[] = conversation
      .recent(REPLAY_DEPTH)
      .map((turn) => ({ question: turn.question, answer: turn.answer }));

    /*
     * The web, when the question asks for it.
     *
     * Decided from the words the user used, not by the model — see
     * core/brain/web.ts. The addendum is appended only on the turns it is on,
     * so the rule against using anything but the notes is not quietly relaxed
     * on every other turn.
     */
    const web = webTriggerFor(question);

    let answer;
    try {
      answer = await mind.answer(
        question,
        notesBlock,
        web === null ? SYSTEM_PROMPT : SYSTEM_PROMPT + '\n' + WEB_ADDENDUM,
        {
          memory: memoryBlock,
          history,
          ...(web === null ? {} : { web: true }),
        }
      );
    } catch (error) {
      /*
       * No answer, but something was kept.
       *
       * Writing it down is this server's job and it has already happened;
       * failing the whole request would throw that away and leave the user
       * thinking it had not. So the keeping is reported and the failure is
       * reported with it, rather than one standing for the other.
       *
       * `answer` is null and not a sentence: inventing one here would be
       * putting words in his mouth, which is the one thing the persona is
       * built to prevent.
       */
      if (remembered.length > 0 && error instanceof MindError) {
        return res.json({
          answer: null,
          answerUnavailable: error.message,
          grounded: false,
          sources: [],
          usedMemory: 0,
          usedHistory: 0,
          remembered,
          ...(notRemembered.length > 0 ? { notRemembered } : {}),
          recorded: false,
          canSpeak: false,
        });
      }
      throw error;
    }

    // Written down, unless it carried something that looked like a
    // credential — in which case it is refused rather than redacted, and the
    // reply is still given. Saying it aloud is not the same as filing it.
    const recorded = conversation.record({
      question,
      answer: answer.text,
      sessionId: SESSION_ID,
      grounded: answer.grounded,
    });

    res.json({
      answer: answer.text,
      grounded: answer.grounded,
      // What turned the web on, whether it was used, and what it found. All
      // three, because "he searched" and "he was allowed to search" are
      // different facts and the screen should not have to guess.
      web:
        web === null
          ? null
          : { trigger: web.phrase, searches: answer.searches, sources: answer.sources },
      // What the words were taken to mean about notes, and what was written
      // if anything was. The screen acts on the first and says the second.
      notepad:
        pad === null
          ? null
          : { action: pad.action, subject: pad.subject, phrase: pad.phrase, saved: padSaved },
      // Which notes were used, so a wrong answer is traceable to its source.
      sources: sources.map((source) => ({
        id: source.id,
        label: galaxy.nodes[source.id]?.label ?? null,
      })),
      usedMemory: context.items.length,
      remembered,
      ...(notRemembered.length > 0 ? { notRemembered } : {}),
      // How much of the conversation he had to hand, and whether this one
      // went into it.
      usedHistory: history.length,
      recorded: recorded.kept,
      ...(recorded.kept ? {} : { notRecorded: recorded.reason }),
      canSpeak: voice.configured,
    });
  } catch (error) {
    if (error instanceof MindError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Ask failed:', error);
    res.status(500).json({ error: 'Helix could not answer.' });
  }
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    private_network_access: true,
    services: {
      gmail: tokenStore.has('gmail') ? 'authenticated' : 'not authenticated',
      youtube: tokenStore.has('youtube') ? 'authenticated' : 'not authenticated',
      generators: 'available',
      voice: voice.configured ? 'available' : 'not configured',
      mind: mind.configured ? 'available' : 'not configured',
    },
  });
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, HOST, () => {
  const suffix = HELIX_TOKEN === '' ? '' : `/?token=${HELIX_TOKEN}`;
  console.log(`Helix server running on http://${HOST}:${PORT}${suffix}`);
  console.log(
    HELIX_TOKEN === ''
      ? 'Local only. Set HOST and HELIX_TOKEN to reach it from another device.'
      : 'Token required. Open the URL above on your phone to sign it in.'
  );
  console.log(`Connect Google: http://${HOST}:${PORT}/auth/gmail/start${suffix === '' ? '' : suffix.slice(1)}`);
}).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or set PORT.`);
  } else {
    console.error('Server failed to start:', err);
  }
  process.exit(1);
});
