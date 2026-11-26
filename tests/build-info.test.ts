import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCommit, buildDefines } from '../src/build-info.js';

describe('buildCommit', () => {
  test('a clean build of the release tag shows no commit', () => {
    expect(buildCommit({ version: '0.1.4', sha: '377df78', tag: 'v0.1.4', dirty: false })).toBeNull();
  });

  test('a build after the release shows its commit', () => {
    expect(buildCommit({ version: '0.1.4', sha: '702daf5', tag: null, dirty: false })).toBe('702daf5');
  });

  test('a tag that does not match the version still shows the commit', () => {
    expect(buildCommit({ version: '0.1.5', sha: '377df78', tag: 'v0.1.4', dirty: false })).toBe('377df78');
  });

  test('uncommitted changes are marked, even on the release tag', () => {
    expect(buildCommit({ version: '0.1.4', sha: '377df78', tag: 'v0.1.4', dirty: true })).toBe('377df78-dirty');
  });

  test('no git (a build from an unpacked tarball) shows no commit', () => {
    expect(buildCommit({ version: '0.1.4', sha: null, tag: null, dirty: false })).toBeNull();
  });
});

describe('a bundled build', () => {
  test('carries the version and commit it was built from, not what package.json says later', async () => {
    const out = mkdtempSync(join(tmpdir(), 'tp-build-'));
    try {
      const r = await Bun.build({
        entrypoints: [join(import.meta.dir, '../src/version.ts')],
        outdir: out,
        target: 'node',
        define: buildDefines({ version: '9.9.9', commit: 'abc1234' }),
      });
      expect(r.success).toBe(true);
      const mod = await import(join(out, 'version.js'));
      expect(mod.VERSION).toBe('9.9.9');
      expect(mod.COMMIT).toBe('abc1234');
      expect(mod.VERSION_LABEL).toBe('9.9.9 (abc1234)');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
