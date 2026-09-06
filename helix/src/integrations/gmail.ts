import { OAuth2Client } from 'google-auth-library';

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

  constructor(config: GmailConfig) {
    this.auth = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUrl);
  }

  getAuthUrl(scopes: string[] = ['https://www.googleapis.com/auth/gmail.readonly']) {
    return this.auth.generateAuthUrl({
      access_type: 'offline',
      // Google returns a refresh token only on the first authorisation unless
      // consent is re-prompted; without one the connection cannot outlive the
      // access token's hour.
      prompt: 'consent',
      scope: scopes,
    });
  }

  /**
   * The library refreshes the access token on its own once it expires. Without
   * somewhere to put the replacement the caller keeps persisting the stale one
   * and refreshes again on every request, and a rotated refresh token would be
   * lost outright.
   */
  onTokenRefresh(handler: (accessToken: string, refreshToken: string | null, expiresAt?: number) => void) {
    this.auth.on('tokens', (tokens) => {
      if (!tokens.access_token) return;
      handler(tokens.access_token, tokens.refresh_token ?? null, tokens.expiry_date ?? undefined);
    });
  }

  async setCredentials(code: string) {
    const { tokens } = await this.auth.getToken(code);
    this.auth.setCredentials(tokens);
    return tokens;
  }

  async setAccessToken(
    accessToken: string,
    refreshToken: string | null = null,
    expiresAt?: number
  ) {
    // expiry_date is what drives the library's automatic refresh: its
    // isTokenExpiring() returns false whenever the field is absent, so leaving
    // it out means the token is never renewed and calls start failing after
    // roughly an hour.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const creds: any = {
      access_token: accessToken,
      refresh_token: refreshToken ?? null,
    };
    if (expiresAt !== undefined) creds.expiry_date = expiresAt;
    this.auth.setCredentials(creds);
  }

  async fetchEmails(query = 'is:important', maxResults = 10): Promise<Email[]> {
    try {
      const { google } = await import('googleapis');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gmail = (google.gmail as any)({ version: 'v1', auth: this.auth });

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
          const getHeader = (name: string): string => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const h = headers.find((hdr: any) => hdr.name === name);
            return h?.value || '';
          };

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

          const internalDate = fullMsg.data.internalDate || '0';
          const labelIds = fullMsg.data.labelIds || [];

          emails.push({
            id: msg.id,
            from: getHeader('From'),
            to: getHeader('To'),
            subject: getHeader('Subject'),
            snippet: fullMsg.data.snippet || '',
            body: body.substring(0, 500),
            timestamp: parseInt(internalDate, 10),
            labels: labelIds,
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
