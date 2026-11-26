import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { VERSION, COMMIT, VERSION_LABEL, versionLabel } from '../src/version.js';

describe('VERSION', () => {
  test('comes from package.json when running from source, so bumping the version there is enough', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    expect(VERSION).toBe(pkg.version);
    expect(COMMIT).toBeNull();
    expect(VERSION_LABEL).toBe(pkg.version);
  });

  test('versionLabel adds the commit when there is one', () => {
    expect(versionLabel('0.1.4', null)).toBe('0.1.4');
    expect(versionLabel('0.1.4', '702daf5')).toBe('0.1.4 (702daf5)');
  });
});
