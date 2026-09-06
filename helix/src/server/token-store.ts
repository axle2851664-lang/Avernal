import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface TokenData {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

/**
 * OAuth tokens survive a restart only if they are written down. Without this
 * the server forgets every connection the moment it stops, so a workflow that
 * involves restarting it means re-authorising each time.
 */
export class TokenStore {
  private readonly file: string;
  private tokens: Record<string, TokenData> = {};

  constructor(packageRoot: string, filename = '.tokens.json') {
    this.file = join(packageRoot, filename);
    this.load();
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        this.tokens = parsed as Record<string, TokenData>;
      }
    } catch {
      // No store yet, or it is unreadable; start empty rather than refusing to boot.
    }
  }

  private persist(): void {
    try {
      // 0600: these are live credentials for the user's mail account.
      writeFileSync(this.file, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`Could not save tokens to ${this.file}:`, err);
    }
  }

  get(service: string): TokenData | undefined {
    return this.tokens[service];
  }

  set(service: string, data: TokenData): void {
    this.tokens[service] = data;
    this.persist();
  }

  has(service: string): boolean {
    return this.tokens[service] !== undefined;
  }
}
