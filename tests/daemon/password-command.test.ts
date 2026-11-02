import { describe, test, expect } from 'bun:test';
import { setPassword } from '../../src/commands/password.js';
import { verifyPassword } from '../../src/daemon/auth.js';
import { memStore, cfgWith } from '../services/helpers.js';

describe('password set', () => {
  test('stores a verifiable hash and keeps other config', () => {
    const store = memStore(cfgWith('app'));
    expect(setPassword('long-enough-pw', 'long-enough-pw', store)).toBeNull();
    expect(verifyPassword('long-enough-pw', store.current.web!.passwordHash!)).toBe(true);
    expect(store.current.tunnels.app).toBeDefined();
  });

  test('rejects mismatch and short passwords without writing', () => {
    const store = memStore(cfgWith());
    expect(setPassword('long-enough-pw', 'different-pw', store)).toBe('Passwords do not match.');
    expect(setPassword('short', 'short', store)).toBe('Password must be at least 8 characters.');
    expect(store.current.web).toBeUndefined();
  });
});
