import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { VERSION } from '../src/version.js';

describe('VERSION', () => {
  test('comes from package.json, so bumping the version there is enough', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    expect(VERSION).toBe(pkg.version);
  });
});
