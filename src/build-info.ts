// Used by tsup.config.ts at build time; not part of the bundle.
import { execFileSync } from 'child_process';

export interface GitState {
  version: string;
  /** Short commit hash, or null when the build is not from a git checkout. */
  sha: string | null;
  /** Every tag on HEAD (a release candidate and the release can share a commit). */
  tags: string[];
  /** Uncommitted changes to tracked files. */
  dirty: boolean;
}

/** The commit to show next to the version, or null for a clean build of that version's release tag. */
export function buildCommit(g: GitState): string | null {
  if (!g.sha) return null;
  if (g.tags.includes(`v${g.version}`) && !g.dirty) return null;
  return g.dirty ? `${g.sha}-dirty` : g.sha;
}

/** The constants the bundler bakes into src/version.ts. */
export function buildDefines(b: { version: string; commit: string | null }): Record<string, string> {
  return {
    __BUILD_VERSION__: JSON.stringify(b.version),
    __BUILD_COMMIT__: JSON.stringify(b.commit),
  };
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function readGitState(version: string, cwd: string = process.cwd()): GitState {
  return {
    version,
    sha: git(cwd, 'rev-parse', '--short=7', 'HEAD'),
    tags: git(cwd, 'tag', '--points-at', 'HEAD')?.split('\n') ?? [],
    dirty: git(cwd, 'status', '--porcelain', '--untracked-files=no') !== null,
  };
}
