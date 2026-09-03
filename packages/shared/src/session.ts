import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Session code generation and constant-time verification.
 * The code is a short random 6-digit string shared out-of-band with the guest; both host and guest
 * use it as `Authorization: Bearer <code>`.
 */

export const SESSION_CODE_LENGTH = 6;

/** Generate a random 6-digit session code (000000-999999, zero-padded). */
export function generateSessionCode(length: number = SESSION_CODE_LENGTH): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += randomInt(0, 10).toString();
  }
  return code;
}

/** Generate a random unguessable session id (used for the host session registry / display). */
export function generateSessionId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Constant-time string comparison (avoids timing side channel on the auth code).
 * When lengths differ, still compare full buffers so timing doesn't leak length.
 */
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length === bBuf.length) {
    return timingSafeEqual(aBuf, bBuf);
  }
  // Unequal lengths: do a dummy compare of equal-length buffers to keep timing flat-ish, then return false.
  timingSafeEqual(aBuf, aBuf);
  return false;
}
