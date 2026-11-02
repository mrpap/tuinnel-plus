import { describe, test, expect } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { resolveStateDir } from '../../src/config/paths.js';

const DEFAULT = join(homedir(), '.tuinnel');

describe('resolveStateDir', () => {
  test('defaults to ~/.tuinnel when TUINNEL_HOME is unset', () => {
    expect(resolveStateDir({})).toBe(DEFAULT);
  });

  test('uses TUINNEL_HOME when set (isolated fork/dev directory)', () => {
    expect(resolveStateDir({ TUINNEL_HOME: '/tmp/tuinnel-plus' })).toBe('/tmp/tuinnel-plus');
  });

  test('trims surrounding whitespace in TUINNEL_HOME', () => {
    expect(resolveStateDir({ TUINNEL_HOME: '  /tmp/tp  ' })).toBe('/tmp/tp');
  });

  test('ignores an empty or whitespace-only TUINNEL_HOME', () => {
    expect(resolveStateDir({ TUINNEL_HOME: '' })).toBe(DEFAULT);
    expect(resolveStateDir({ TUINNEL_HOME: '   ' })).toBe(DEFAULT);
  });
});
