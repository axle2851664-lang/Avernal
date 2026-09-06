import express from 'express';
import type { Request, Response } from 'express';
import { GmailSync, type Email } from '../integrations/gmail.js';
import { YouTubeSync, type Video } from '../integrations/youtube.js';
import { generateImage, generateVideo } from '../integrations/generators.js';
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

interface TokenData {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

const accessTokens = new Map<string, TokenData>();
const youtubeTokens = new Map<string, TokenData>();

// Middleware: verify private network access
app.use((_req: Request, res: Response, next: () => void) => {
  const clientIp = (_req.ip || _req.socket.remoteAddress || '').toString();
  if (!isPrivateNetwork(clientIp)) {
    return res.status(403).json({ error: 'Access denied: not on private network' });
  }
  next();
});

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

    accessTokens.set('default', {
      accessToken,
      refreshToken,
      expiresAt,
    });
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
  const tokenData = accessTokens.get('default');
  if (!tokenData) {
    return res.status(401).json({ error: 'Gmail not authenticated. Run /auth/gmail/start first' });
  }

  try {
    await gmailSync.setAccessToken(tokenData.accessToken, tokenData.refreshToken);
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
  const tokenData = accessTokens.get('default');
  if (!tokenData) {
    return res.status(401).json({ error: 'Gmail not authenticated' });
  }

  try {
    await gmailSync.setAccessToken(tokenData.accessToken, tokenData.refreshToken);
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

    youtubeTokens.set('default', {
      accessToken,
      refreshToken,
      expiresAt,
    });
    res.json({ success: true, message: 'YouTube connected successfully. You can now sync videos.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to authenticate with YouTube', details: String(error) });
  }
});

// Fetch and sync YouTube videos
app.post('/sync/youtube/videos', async (_req: Request, res: Response) => {
  const tokenData = youtubeTokens.get('default');
  if (!tokenData) {
    return res
      .status(401)
      .json({ error: 'YouTube not authenticated. Visit http://localhost:3000/auth/youtube/start' });
  }

  try {
    await youtubeSync.setAccessToken(tokenData.accessToken, tokenData.refreshToken);
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

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    private_network_access: true,
    services: {
      gmail: accessTokens.has('default') ? 'authenticated' : 'not authenticated',
      youtube: youtubeTokens.has('default') ? 'authenticated' : 'not authenticated',
      generators: 'available',
    },
  });
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Helix server running on http://localhost:${PORT}`);
  console.log(`Private network access required`);
  console.log(`OAuth start: GET http://localhost:${PORT}/auth/gmail/start`);
}).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or set PORT.`);
  } else {
    console.error('Server failed to start:', err);
  }
  process.exit(1);
});
