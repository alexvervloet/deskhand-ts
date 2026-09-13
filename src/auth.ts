/**
 * Passwords and session tokens.
 *
 * Small on purpose. The only decisions here worth stating: passwords are bcrypt
 * hashed, and the session token the client holds is never stored — only its
 * SHA-256 digest is, so a dump of `sessions` cannot be replayed as a login.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";

/** Seven days. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const BCRYPT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch {
    // A malformed hash in the row is a failed login, not a 500.
    return false;
  }
}

/** Returns [token_for_the_client, digest_for_the_database]. */
export function newSessionToken(): [string, string] {
  const token = randomBytes(32).toString("base64url");
  return [token, hashToken(token)];
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
}

/**
 * Compare two hex digests without leaking where they first differ.
 *
 * The session lookup is a database equality test and is not the reason this
 * exists; it is here for anywhere a digest is compared in application code,
 * where `===` on a secret is a timing oracle.
 */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
