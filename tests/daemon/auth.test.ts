import { describe, test, expect } from 'bun:test';
import { hashPassword, verifyPassword, SessionStore, RateLimiter, MIN_PASSWORD_LENGTH } from '../../src/daemon/auth.js';

describe('password hashing', () => {
  test('hash verifies, wrong password fails', () => {
    const h = hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(verifyPassword('correct horse', h)).toBe(true);
    expect(verifyPassword('wrong horse', h)).toBe(false);
  });

  test('two hashes of same password differ', () => {
    expect(hashPassword('same-password')).not.toBe(hashPassword('same-password'));
  });

  test('malformed stored hash → false', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false);
    expect(verifyPassword('x', 'scrypt$zz$yy')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
  });

  test('minimum length is 8', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
  });
});

describe('SessionStore', () => {
  test('issued session is valid; unknown is not', () => {
    const s = new SessionStore();
    const id = s.create();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(s.valid(id)).toBe(true);
    expect(s.valid('nope')).toBe(false);
  });

  test('session expires after ttl', () => {
    let now = 1000;
    const s = new SessionStore(100, () => now);
    const id = s.create();
    now = 1099;
    expect(s.valid(id)).toBe(true);
    now = 1101;
    expect(s.valid(id)).toBe(false);
  });

  test('revoke and revokeAll invalidate sessions', () => {
    const s = new SessionStore();
    const a = s.create();
    const b = s.create();
    s.revoke(a);
    expect(s.valid(a)).toBe(false);
    expect(s.valid(b)).toBe(true);
    s.revokeAll();
    expect(s.valid(b)).toBe(false);
  });
});

describe('RateLimiter', () => {
  test('5 failures block, window expiry unblocks, reset clears', () => {
    let now = 0;
    const r = new RateLimiter(5, 1000, () => now);
    for (let i = 0; i < 4; i++) r.fail('ip');
    expect(r.blocked('ip')).toBe(false);
    r.fail('ip');
    expect(r.blocked('ip')).toBe(true);
    expect(r.blocked('other')).toBe(false);
    now = 1001;
    expect(r.blocked('ip')).toBe(false);
    for (let i = 0; i < 5; i++) r.fail('ip');
    expect(r.blocked('ip')).toBe(true);
    r.reset('ip');
    expect(r.blocked('ip')).toBe(false);
  });
});
