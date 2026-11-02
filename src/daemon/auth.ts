import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export const MIN_PASSWORD_LENGTH = 8;

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/** Hash a password as `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !/^[0-9a-f]+$/.test(saltHex ?? '') || !/^[0-9a-f]+$/.test(hashHex ?? '')) {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  return timingSafeEqual(actual, expected);
}

/** In-memory browser sessions. A daemon restart logs everyone out. */
export class SessionStore {
  private sessions = new Map<string, number>(); // id -> expiresAt

  constructor(
    private ttlMs: number = 7 * 24 * 3600 * 1000,
    private now: () => number = Date.now,
  ) {}

  create(): string {
    const id = randomBytes(32).toString('hex');
    this.sessions.set(id, this.now() + this.ttlMs);
    return id;
  }

  valid(id: string): boolean {
    const expiresAt = this.sessions.get(id);
    if (expiresAt === undefined) return false;
    if (this.now() > expiresAt) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  revoke(id: string): void {
    this.sessions.delete(id);
  }

  revokeAll(): void {
    this.sessions.clear();
  }
}

/** Counts failed logins per client within a sliding window. */
export class RateLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private max: number = 5,
    private windowMs: number = 15 * 60 * 1000,
    private now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  fail(key: string): void {
    this.failures.set(key, [...this.recent(key), this.now()]);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
