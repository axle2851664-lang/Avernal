import express, { Request, Response } from 'express';
import { GmailSync, type Email } from '../integrations/gmail.js';
import { isPrivateNetwork } from '../core/access/private-network.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const gmailSync = new GmailSync({
  clientId: process.env.GMAIL_CLIENT_ID || '',
  clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
  redirectUrl: process.env.GMAIL_REDIRECT_URL || 'http://localhost:3000/auth/gmail/callback',
});

const accessTokens = new Map<string, { accessToken: string; refreshToken?: string; expiresAt: number }>();

// Middleware: verify private network access
app.use((req: Request, res: Response, next) => {
  const clientIp = req.ip || req.socket.remoteAddress || '';
  if (!isPrivateNetwork(clientIp)) {
    return res.status(403).json({ error: 'Access denied: not on private network' });
  }
  next();
});

// OAuth flow start
app.get('/auth/gmail/start', (req: Request, res: Response) => {
  const authUrl = gmailSync.getAuthUrl();
  res.json({ authUrl });
});

// OAuth callback
app.get('/auth/gmail/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    const tokens = await gmailSync.setCredentials(code);
    accessTokens.set('default', {
      accessToken: tokens.access_token || '',
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date || Date.now() + 3600000,
    });
    res.json({ success: true, message: 'Gmail connected successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to authenticate with Gmail', details: String(error) });
  }
});

// Convert email to note format
function emailToNote(email: Email): { title: string; content: string; tags: string[] } {
  const from = email.from.split('<')[0].trim();
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
app.post('/sync/gmail/unread', async (req: Request, res: Response) => {
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
  const { sender } = req.params;
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

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', private_network_access: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Helix server running on http://localhost:${PORT}`);
  console.log(`Private network access required`);
  console.log(`OAuth start: GET http://localhost:${PORT}/auth/gmail/start`);
});
