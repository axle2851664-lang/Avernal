import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';

const COOKIE = 'helix_token';

function digest(value: string): Buffer {
  // Hashing first gives both sides a fixed width, which timingSafeEqual requires.
  return createHash('sha256').update(value).digest();
}

function matches(candidate: string, expected: string): boolean {
  return timingSafeEqual(digest(candidate), digest(expected));
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Gates every request on a shared token. Only installed when the server listens
 * beyond loopback: reaching it from another device means the network is no
 * longer the boundary, and an IP check alone would leave the Gmail tokens this
 * process holds open to anyone who can route to the port.
 */
export function requireToken(expected: string) {
  return (req: Request, res: Response, next: () => void) => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') === true ? header.slice(7) : undefined;
    const query = typeof req.query.token === 'string' ? req.query.token : undefined;
    const cookie = readCookie(req.headers.cookie, COOKIE);

    const supplied = bearer ?? query ?? cookie;
    if (supplied !== undefined && matches(supplied, expected)) {
      // Remember a token passed in the URL so a phone browser stays signed in
      // and the secret stops appearing in later requests.
      if (query !== undefined && cookie !== query) {
        res.setHeader(
          'Set-Cookie',
          `${COOKIE}=${encodeURIComponent(query)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
        );
      }
      return next();
    }

    res.status(401).json({ error: 'Missing or invalid token. Append ?token=... to the URL.' });
  };
}
