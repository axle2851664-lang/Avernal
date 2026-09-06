import { OAuth2Client } from 'google-auth-library';
import { gmail_v1 } from 'googleapis';

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
}

export interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  body: string;
  timestamp: number;
  labels: string[];
}

export class GmailSync {
  private auth: OAuth2Client;
  private gmail: gmail_v1.Gmail | null = null;

  constructor(config: GmailConfig) {
    this.auth = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUrl);
  }

  getAuthUrl(scopes: string[] = ['https://www.googleapis.com/auth/gmail.readonly']) {
    return this.auth.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
    });
  }

  async setCredentials(code: string) {
    const { tokens } = await this.auth.getToken(code);
    this.auth.setCredentials(tokens);
    return tokens;
  }

  async setAccessToken(accessToken: string, refreshToken?: string) {
    this.auth.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  }

  async fetchEmails(query = 'is:important', maxResults = 10): Promise<Email[]> {
    try {
      const { google } = await import('googleapis');
      const gmail = google.gmail({ version: 'v1', auth: this.auth });

      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults,
      });

      const messages = listRes.data.messages || [];
      const emails: Email[] = [];

      for (const msg of messages) {
        if (!msg.id) continue;
        try {
          const fullMsg = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full',
          });

          const payload = fullMsg.data.payload;
          if (!payload) continue;

          const headers = payload.headers || [];
          const getHeader = (name: string) => headers.find((h) => h.name === name)?.value || '';

          let body = '';
          if (payload.parts) {
            for (const part of payload.parts) {
              if (part.mimeType === 'text/plain' && part.body?.data) {
                body = Buffer.from(part.body.data, 'base64').toString();
                break;
              }
            }
          } else if (payload.body?.data) {
            body = Buffer.from(payload.body.data, 'base64').toString();
          }

          emails.push({
            id: msg.id,
            from: getHeader('From'),
            to: getHeader('To'),
            subject: getHeader('Subject'),
            snippet: fullMsg.data.snippet || '',
            body: body.substring(0, 500),
            timestamp: parseInt(fullMsg.data.internalDate || '0'),
            labels: fullMsg.data.labelIds || [],
          });
        } catch (e) {
          console.error(`Failed to fetch message ${msg.id}:`, e);
        }
      }

      return emails;
    } catch (error) {
      console.error('Error fetching Gmail:', error);
      throw error;
    }
  }

  async fetchUnread(): Promise<Email[]> {
    return this.fetchEmails('is:unread', 20);
  }

  async fetchFromSender(email: string, maxResults = 5): Promise<Email[]> {
    return this.fetchEmails(`from:${email}`, maxResults);
  }
}
