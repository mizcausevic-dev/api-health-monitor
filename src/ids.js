import { randomBytes } from 'node:crypto';

// Crockford base32 ULID: 48-bit millisecond timestamp + 80 random bits.
// Lexicographic order follows creation time, which keeps IDs index-friendly.
const B32 = '0123456789abcdefghjkmnpqrstvwxyz';

export function ulid(now = Date.now()) {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  let value = 0;
  let bits = 0;
  for (const byte of randomBytes(10)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      rand += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return time + rand;
}

export const newId = (prefix, now) => `${prefix}_${ulid(now)}`;

export const ID_PATTERN = /^(mon|chk|inc)_[0-9a-hjkmnp-tv-z]{26}$/;
