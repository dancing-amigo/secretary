import crypto from 'crypto';

export function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}
