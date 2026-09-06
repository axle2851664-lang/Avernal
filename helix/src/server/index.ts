import express from 'express';
import type { Request, Response } from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GmailSync, type Email } from '../integrations/gmail.js';
import { YouTubeSync, type Video } from '../integrations/youtube.js';
import { generateImage, generateVideo } from '../integrations/generators.js';
import { TokenStore } from './token-store.js';
import { isLoopback, requireToken } from './auth.js';
import { draftCapture } from '../core/galaxy/capture.js';
import { existingCaptureSlugs, writeCapture } from '../platform/vault/index.js';
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

const gmailSync = new GmailSync({
  clientId: process.env.GMAIL_CLIENT_ID || '',
  clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
  redirectUrl: process.env.GMAIL_REDIRECT_URL || 'http://localhost:3000/auth/gmail/callback',
});

const youtubeSync = new YouTubeSync({
  clientId: process.env.YOUTUBE_CLIENT_ID || '',
  clientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',
  redirectUrl: process.env.YOUTUBE_REDIRECT_URL || 'http://localhost:3000/auth/youtube/callback',
});

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

// OAuth flow start
app.get('/auth/gmail/start', (_req: Request, res: Response) => {
  const authUrl = gmailSync.getAuthUrl();
  res.json({ authUrl });
});

// OAuth callback
app.get('/auth/gmail/callback', async (req: Request, res: Response) => {
  const code = req.query.code;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    const tokens = await gmailSync.setCredentials(code);
    const accessToken = tokens.access_token || '';
    const refreshToken = tokens.refresh_token || null;
    const expiresAt = tokens.expiry_date || Date.now() + 3600000;

    tokenStore.set('gmail', { accessToken, refreshToken, expiresAt });
    res.json({ success: true, message: 'Gmail connected successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to authenticate with Gmail', details: String(error) });
  }
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
app.get('/auth/youtube/start', (_req: Request, res: Response) => {
  const authUrl = youtubeSync.getAuthUrl();
  res.json({ authUrl });
});

// YouTube OAuth callback
app.get('/auth/youtube/callback', async (req: Request, res: Response) => {
  const code = req.query.code;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    const tokens = await youtubeSync.setCredentials(code);
    const accessToken = tokens.access_token || '';
    const refreshToken = tokens.refresh_token || null;
    const expiresAt = tokens.expiry_date || Date.now() + 3600000;

    tokenStore.set('youtube', { accessToken, refreshToken, expiresAt });
    res.json({ success: true, message: 'YouTube connected successfully. You can now sync videos.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to authenticate with YouTube', details: String(error) });
  }
});

// Fetch and sync YouTube videos
app.post('/sync/youtube/videos', async (_req: Request, res: Response) => {
  const tokenData = tokenStore.get('youtube');
  if (!tokenData) {
    return res
      .status(401)
      .json({ error: 'YouTube not authenticated. Visit http://localhost:3000/auth/youtube/start' });
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

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    private_network_access: true,
    services: {
      gmail: tokenStore.has('gmail') ? 'authenticated' : 'not authenticated',
      youtube: tokenStore.has('youtube') ? 'authenticated' : 'not authenticated',
      generators: 'available',
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
  console.log(`OAuth start: GET http://${HOST}:${PORT}/auth/gmail/start`);
}).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or set PORT.`);
  } else {
    console.error('Server failed to start:', err);
  }
  process.exit(1);
});
