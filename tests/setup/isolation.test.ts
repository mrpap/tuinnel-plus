import { describe, test, expect } from 'bun:test';
import { userInfo } from 'os';
import { join } from 'path';
import { CONFIG_DIR, CONFIG_PATH } from '../../src/config/store.js';
import { BIN_DIR } from '../../src/cloudflared/binary.js';
import { resolveStateDir } from '../../src/config/paths.js';

// The suite must never touch the real ~/.tuinnel. tests/setup/isolate-state.ts
// (bunfig preload) points TUINNEL_HOME at a throwaway directory before any
// module loads.
// userInfo() reads the account database, so no HOME change or os mock can fake it.
const REAL_STATE_DIR = join(userInfo().homedir, '.tuinnel');

describe('test isolation', () => {
  test('state dir is not the real ~/.tuinnel', () => {
    expect(resolveStateDir()).not.toBe(REAL_STATE_DIR);
    expect(CONFIG_DIR.startsWith(REAL_STATE_DIR)).toBe(false);
    expect(CONFIG_PATH.startsWith(REAL_STATE_DIR)).toBe(false);
    expect(BIN_DIR.startsWith(REAL_STATE_DIR)).toBe(false);
  });

  test('refuses to resolve to the real ~/.tuinnel while testing', () => {
    const saved = process.env.TUINNEL_HOME;
    try {
      delete process.env.TUINNEL_HOME;
      expect(() => resolveStateDir()).toThrow('real ~/.tuinnel');
      process.env.TUINNEL_HOME = REAL_STATE_DIR;
      expect(() => resolveStateDir()).toThrow('real ~/.tuinnel');
    } finally {
      process.env.TUINNEL_HOME = saved;
    }
  });
});
