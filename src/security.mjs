import { createHmac, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

export function keyFromHex(value, label) {
  if (!/^[0-9a-f]{64}$/i.test(value || '')) throw new Error(label + ' must be 32 random bytes (64 hex digits)');
  return Buffer.from(value, 'hex');
}
function mac(key, message) {
  return createHmac('sha256', key).update(message).digest('base64url');
}
function eq(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
}
export function createSession(key, now = Date.now()) {
  const expires = Math.floor(now / 1000) + 12 * 60 * 60;
  const payload = 'v1.' + expires + '.' + randomBytes(20).toString('base64url');
  return payload + '.' + mac(key, payload);
}
export function readSession(key, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 300) return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const expires = Number(parts[1]);
  if (!Number.isSafeInteger(expires) || expires < Math.floor(now / 1000)) return false;
  return eq(parts[3], mac(key, parts.slice(0, 3).join('.')));
}
export function csrfToken(key, session) {
  return mac(key, 'csrf:' + session);
}
export function validateCsrf(key, session, token) {
  return eq(csrfToken(key, session), token);
}
export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const cut = part.indexOf('=');
    if (cut > 0) out[part.slice(0, cut).trim()] = part.slice(cut + 1).trim();
  }
  return out;
}
export function passwordMatches(input, expected) {
  if (typeof input !== 'string' || input.length > 512 || !expected) return false;
  const salt = Buffer.from('the-bridge-single-owner-password-v1');
  return timingSafeEqual(scryptSync(input, salt, 32), scryptSync(expected, salt, 32));
}
export function seal(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
export function unseal(key, sealed) {
  const parts = String(sealed).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid encrypted token');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}
