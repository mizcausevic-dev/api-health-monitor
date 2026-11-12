// SSRF guard. A monitoring service is, by definition, a machine that makes
// HTTP requests to user-supplied URLs. Without this module it is also a proxy
// into whatever network it runs in (cloud metadata at 169.254.169.254,
// databases on 10.x, admin panels on localhost).
//
// The check runs inside the socket's DNS lookup, so the address that is
// validated is the address that is connected to. Validating the hostname
// first and connecting later would leave a DNS-rebinding window.
import dns from 'node:dns';
import net from 'node:net';

const V4_BLOCKS = [
  ['0.0.0.0', 8, 'this network'],
  ['10.0.0.0', 8, 'private (RFC 1918)'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata'],
  ['172.16.0.0', 12, 'private (RFC 1918)'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private (RFC 1918)'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
  ['168.63.129.16', 32, 'Azure platform endpoint (WireServer)'],
];

const V6_BLOCKS = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['::', 96, 'IPv4-compatible (deprecated)'],
  ['100::', 64, 'discard-only'],
  // Local-use NAT64 (RFC 8215) embeds IPv4 at prefix-dependent offsets, so
  // the whole range is refused rather than decoded.
  ['64:ff9b:1::', 48, 'local-use NAT64'],
  ['2001::', 32, 'Teredo'],
  ['2001:db8::', 32, 'documentation'],
  ['fc00::', 7, 'unique local'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local (deprecated)'],
  ['ff00::', 8, 'multicast'],
];

const v4 = new net.BlockList();
const v4Reason = [];
for (const [addr, prefix, why] of V4_BLOCKS) {
  v4.addSubnet(addr, prefix, 'ipv4');
  const one = new net.BlockList();
  one.addSubnet(addr, prefix, 'ipv4');
  v4Reason.push([one, why]);
}
const v6Reason = V6_BLOCKS.map(([addr, prefix, why]) => {
  const one = new net.BlockList();
  one.addSubnet(addr, prefix, 'ipv6');
  return [one, why];
});

export const isIpLiteral = (host) => net.isIP(host) !== 0;

function expandV6(addr) {
  const [head, tail = ''] = addr.split('::');
  let parts = head ? head.split(':') : [];
  let rest = addr.includes('::') ? (tail ? tail.split(':') : []) : [];
  // Dotted-quad suffix (::ffff:1.2.3.4) becomes two hex groups.
  const last = (rest.length ? rest : parts).at(-1);
  if (last && last.includes('.')) {
    const o = last.split('.').map(Number);
    const hex = [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
    if (rest.length) rest = [...rest.slice(0, -1), ...hex];
    else parts = [...parts.slice(0, -1), ...hex];
  }
  const fill = addr.includes('::') ? 8 - parts.length - rest.length : 0;
  return [...parts, ...Array(fill).fill('0'), ...rest].map((g) => Number.parseInt(g || '0', 16));
}

// IPv6 forms that embed an IPv4 address must be judged by that IPv4 address.
function embeddedV4(groups) {
  const toV4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (n) => groups.slice(0, n).every((g) => g === 0);
  if (zeros(5) && groups[5] === 0xffff) return toV4(groups[6], groups[7]); // ::ffff:a.b.c.d (mapped)
  if (zeros(4) && groups[4] === 0xffff && groups[5] === 0) return toV4(groups[6], groups[7]); // ::ffff:0:a.b.c.d (translated)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) return toV4(groups[6], groups[7]); // NAT64 well-known
  if (groups[0] === 0x2002) return toV4(groups[1], groups[2]); // 6to4
  return null;
}

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    if (!v4.check(address, 'ipv4')) return { blocked: false };
    return { blocked: true, reason: v4Reason.find(([bl]) => bl.check(address, 'ipv4'))[1] };
  }
  if (family === 6) {
    const clean = address.split('%')[0];
    const inner = embeddedV4(expandV6(clean));
    if (inner) return isBlockedAddress(inner);
    const hit = v6Reason.find(([bl]) => bl.check(clean, 'ipv6'));
    return hit ? { blocked: true, reason: hit[1] } : { blocked: false };
  }
  return { blocked: true, reason: 'not an IP address' };
}

export class BlockedTargetError extends Error {
  constructor(host, address, reason) {
    super(`${host} resolves to ${address} (${reason}); private targets are disabled`);
    this.code = 'EBLOCKEDTARGET';
  }
}

// Drop-in replacement for dns.lookup, passed to http.request({ lookup }).
// If ANY resolved address is blocked the whole lookup fails, so a hostname
// with one public and one private record cannot be used to reach the latter.
export function guardedLookup({ allowPrivate = false, resolver = dns.lookup } = {}) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    resolver(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!allowPrivate) {
        for (const { address } of addresses) {
          const verdict = isBlockedAddress(address);
          if (verdict.blocked) return callback(new BlockedTargetError(hostname, address, verdict.reason));
        }
      }
      if (options.all) return callback(null, addresses);
      const [first] = addresses;
      return callback(null, first.address, first.family);
    });
  };
}
