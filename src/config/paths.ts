import { homedir, userInfo } from 'os';
import { join, resolve } from 'path';

/**
 * Resolve the tuinnel-plus state directory — where the config, PID file, and
 * cloudflared binary live.
 *
 * Defaults to `~/.tuinnel`; the `TUINNEL_HOME` environment variable points it
 * somewhere else, e.g. to run a second, fully separate instance.
 *
 * Under the test runner (NODE_ENV=test) it refuses to return the real
 * ~/.tuinnel, so a test that slips past the sandbox fails instead of writing
 * to your own setup.
 *
 * @param env environment to read (defaults to process.env; injectable for tests)
 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TUINNEL_HOME?.trim();
  const dir = override || join(homedir(), '.tuinnel');
  if (env === process.env && process.env.NODE_ENV === 'test') assertNotRealStateDir(dir);
  return dir;
}

function assertNotRealStateDir(dir: string): void {
  const real = join(userInfo().homedir, '.tuinnel');
  const target = resolve(dir);
  if (target === real || target.startsWith(real + '/')) {
    throw new Error(`Refusing to use the real ~/.tuinnel (${real}) during tests`);
  }
}
