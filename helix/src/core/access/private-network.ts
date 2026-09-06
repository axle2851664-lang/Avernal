/**
 * The boundary that keeps Helix off the open internet.
 *
 * Helix answers from a personal vault and will later reach mail and calendar,
 * so it binds where only trusted devices can reach it: loopback, a home LAN, or
 * a private mesh such as Tailscale. Everything else is refused.
 *
 * The rule is default-deny. An address that cannot be parsed with certainty is
 * treated as public, because the cost of wrongly allowing one is a personal
 * assistant answering a stranger, and the cost of wrongly refusing one is a
 * reconnect.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Reads an IPv4 address into four octets, or null if it is not canonical. */
function parseIpv4(value: string): [number, number, number, number] | null {
  const match = IPV4.exec(value);
  if (match === null) return null;

  const octets: number[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const part = match[index];
    if (part === undefined) return null;

    // "010" is octal to some parsers and decimal to others. Anything
    // non-canonical is refused rather than guessed at.
    if (part.length > 1 && part.startsWith('0')) return null;

    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    octets.push(octet);
  }

  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
}

function isPrivateIpv4(value: string): boolean {
  const octets = parseIpv4(value);
  if (octets === null) return false;

  const [a, b] = octets;

  if (a === 127) return true;                      // loopback
  if (a === 10) return true;                       // RFC1918
  if (a === 192 && b === 168) return true;         // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 169 && b === 254) return true;         // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT — Tailscale's range

  return false;
}

function isPrivateIpv6(value: string): boolean {
  if (value === '::1' || value === '::') return value === '::1';

  const firstHextet = value.split(':')[0] ?? '';
  if (!/^[0-9a-f]{1,4}$/.test(firstHextet)) return false;

  const block = Number.parseInt(firstHextet.padStart(4, '0'), 16);
  if (Number.isNaN(block)) return false;

  if (block >= 0xfc00 && block <= 0xfdff) return true; // unique local, fc00::/7
  if (block >= 0xfe80 && block <= 0xfebf) return true; // link-local, fe80::/10

  return false;
}

/**
 * Strips the decorations a remote address arrives wrapped in: brackets from a
 * URL authority, a port, and an IPv6 zone index.
 */
function normalise(address: string): string {
  let value = address.trim().toLowerCase();

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1] !== undefined) value = bracketed[1];

  // A bare "host:port" only splits safely when there is exactly one colon;
  // more than one means IPv6, where the colons are part of the address.
  const colons = value.split(':').length - 1;
  if (colons === 1) value = value.split(':')[0] ?? value;

  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);

  return value;
}

/**
 * Whether an address belongs to a network only trusted devices can reach.
 *
 * Accepts loopback, RFC1918, link-local, IPv6 unique-local, and the carrier-grade
 * NAT range that Tailscale hands out. Everything else, including anything that
 * fails to parse, is public.
 */
export function isPrivateAddress(address: string): boolean {
  const value = normalise(address);
  if (value === '') return false;

  if (value === 'localhost') return true;

  // ::ffff:192.168.0.1 — an IPv4 address wearing an IPv6 coat, which is how
  // dual-stack sockets usually report LAN clients.
  const mapped = /^::ffff:(.+)$/.exec(value);
  if (mapped?.[1] !== undefined) return isPrivateIpv4(mapped[1]);

  if (value.includes(':')) return isPrivateIpv6(value);
  return isPrivateIpv4(value);
}

/**
 * Guards a request by its socket peer address.
 *
 * Takes the address the connection actually came from — never a forwarded-for
 * or similar header. Those are written by the client, so trusting one lets
 * anyone claim to be on the LAN by typing it.
 */
export function isTrustedPeer(remoteAddress: string | null | undefined): boolean {
  return typeof remoteAddress === 'string' && isPrivateAddress(remoteAddress);
}
