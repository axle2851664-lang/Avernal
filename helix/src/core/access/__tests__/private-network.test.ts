import { describe, expect, it } from 'vitest';

import { isPrivateAddress, isTrustedPeer } from '../private-network.js';

describe('isPrivateAddress', () => {
  it('allows loopback', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  it('allows the RFC1918 home-network ranges', () => {
    for (const address of ['10.0.0.5', '192.168.1.42', '172.16.0.1', '172.31.255.254']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  it('allows the carrier-grade NAT range Tailscale uses', () => {
    for (const address of ['100.64.0.1', '100.101.102.103', '100.127.255.255']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  it('allows IPv6 unique-local and link-local', () => {
    for (const address of ['fd00::1', 'fc00::1', 'fe80::1ff:fe23:4567:890a']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  it('refuses public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '203.0.113.5', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it('refuses the addresses that merely look private', () => {
    // 172.15 and 172.32 sit either side of the RFC1918 block; 100.63 and
    // 100.128 either side of the CGNAT one. All four are public.
    for (const address of ['172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.0']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it('refuses a public address dressed up as a private one', () => {
    for (const address of ['8.8.8.8.192.168.1.1', '192.168.1.1.example.com', '192-168-1-1']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it('unwraps IPv4-mapped IPv6, which is how dual-stack reports LAN clients', () => {
    expect(isPrivateAddress('::ffff:192.168.1.10')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('strips brackets, ports and zone indices', () => {
    expect(isPrivateAddress('192.168.1.10:4700')).toBe(true);
    expect(isPrivateAddress('[::1]:4700')).toBe(true);
    expect(isPrivateAddress('[fe80::1%eth0]')).toBe(true);
    expect(isPrivateAddress('8.8.8.8:4700')).toBe(false);
  });

  it('refuses non-canonical octets rather than guessing how they parse', () => {
    // 0177.0.0.1 is loopback read as octal and nonsense read as decimal.
    for (const address of ['0177.0.0.1', '010.0.0.1', '192.168.01.1']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it('refuses malformed and out-of-range input', () => {
    for (const address of ['', '   ', 'not-an-address', '999.1.1.1', '10.0.0', '10.0.0.1.2', '::']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it('ignores case and surrounding whitespace', () => {
    expect(isPrivateAddress('  FD00::1  ')).toBe(true);
    expect(isPrivateAddress('LOCALHOST')).toBe(true);
  });
});

describe('isTrustedPeer', () => {
  it('accepts a private socket address', () => {
    expect(isTrustedPeer('192.168.1.10')).toBe(true);
  });

  it('refuses a missing address rather than defaulting open', () => {
    expect(isTrustedPeer(null)).toBe(false);
    expect(isTrustedPeer(undefined)).toBe(false);
    expect(isTrustedPeer('')).toBe(false);
  });

  it('refuses a public address', () => {
    expect(isTrustedPeer('203.0.113.5')).toBe(false);
  });
});
