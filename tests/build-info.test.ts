import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCommit, buildDefines, readGitState } from '../src/build-info.js';

describe('buildCommit', () => {
  test('a clean build of the release tag shows no commit', () => {
    expect(buildCommit({ version: '0.1.4', sha: '377df78', tags: ['v0.1.4'], dirty: false })).toBeNull();
  });

  test('another tag on the same commit does not hide the release tag', () => {
    expect(buildCommit({ version: '0.2.0', sha: '377df78', tags: ['v0.2.0-rc.1', 'v0.2.0'], dirty: false })).toBeNull();
  });

  test('a build after the release shows its commit', () => {
    expect(buildCommit({ version: '0.1.4', sha: '702daf5', tags: [], dirty: false })).toBe('702daf5');
  });

  test('a tag that does not match the version still shows the commit', () => {
    expect(buildCommit({ version: '0.1.5', sha: '377df78', tags: ['v0.1.4'], dirty: false })).toBe('377df78');
  });

  test('uncommitted changes are marked, even on the release tag', () => {
    expect(buildCommit({ version: '0.1.4', sha: '377df78', tags: ['v0.1.4'], dirty: true })).toBe('377df78-dirty');
  });

  test('no git (a build from an unpacked tarball) shows no commit', () => {
    expect(buildCommit({ version: '0.1.4', sha: null, tags: [], dirty: false })).toBeNull();
  });
});

describe('readGitState', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });

  test('outside a git checkout: no commit, not dirty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-nogit-'));
    try {
      expect(readGitState('1.0.0', dir)).toEqual({ version: '1.0.0', sha: null, tags: [], dirty: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads every tag on HEAD, and only tracked changes count as dirty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-git-'));
    try {
      git(dir, 'init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'a');
      git(dir, 'add', 'a.txt');
      git(dir, 'commit', '-q', '-m', 'one');
      git(dir, 'tag', 'v1.0.0-rc.1');
      git(dir, 'tag', 'v1.0.0');
      writeFileSync(join(dir, 'untracked.txt'), 'x');

      const clean = readGitState('1.0.0', dir);
      expect(clean.sha).toMatch(/^[0-9a-f]{7}$/);
      expect(clean.tags.sort()).toEqual(['v1.0.0', 'v1.0.0-rc.1']);
      expect(clean.dirty).toBe(false);

      writeFileSync(join(dir, 'a.txt'), 'changed');
      expect(readGitState('1.0.0', dir).dirty).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a bundled build', () => {
  async function bundle(commit: string | null) {
    const out = mkdtempSync(join(tmpdir(), 'tp-build-'));
    try {
      const r = await Bun.build({
        entrypoints: [join(import.meta.dir, '../src/version.ts')],
        outdir: out,
        target: 'node',
        define: buildDefines({ version: '9.9.9', commit }),
      });
      expect(r.success).toBe(true);
      return await import(join(out, 'version.js'));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  test('carries the version and commit it was built from, not what package.json says later', async () => {
    const mod = await bundle('abc1234');
    expect(mod.VERSION).toBe('9.9.9');
    expect(mod.COMMIT).toBe('abc1234');
    expect(mod.VERSION_LABEL).toBe('9.9.9 (abc1234)');
  });

  test('a release build shows the plain version', async () => {
    const mod = await bundle(null);
    expect(mod.VERSION).toBe('9.9.9');
    expect(mod.COMMIT).toBeNull();
    expect(mod.VERSION_LABEL).toBe('9.9.9');
  });
});
