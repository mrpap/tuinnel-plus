import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { configExists, readConfig, getToken, CONFIG_PATH } from '../config/store.js';
import { BINARY_PATH, BIN_DIR } from '../cloudflared/binary.js';
import { validateToken } from '../cloudflare/api.js';

interface Check {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

interface CloudflaredDeps {
  env: Record<string, string | undefined>;
  managedPath: string;
  exists: (path: string) => boolean;
  version: (path: string) => string;
}

const realDeps: CloudflaredDeps = {
  env: process.env,
  managedPath: BINARY_PATH,
  exists: existsSync,
  version: (path) => execFileSync(path, ['version', '--short'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim(),
};

/** Check the cloudflared tuinnel-plus will actually run (see ensureBinary). */
export function checkCloudflared(deps: CloudflaredDeps = realDeps): { ok: boolean; detail: string } {
  const external = deps.env.TUINNEL_CLOUDFLARED?.trim();
  const path = external || deps.managedPath;
  if (!deps.exists(path)) {
    return external
      ? { ok: false, detail: `TUINNEL_CLOUDFLARED points to ${external}, which does not exist` }
      : { ok: false, detail: `Not found in ${BIN_DIR}/. Will be downloaded on first \`up\`` };
  }
  try {
    const version = deps.version(path);
    return { ok: true, detail: external ? `Version ${version} (${external}, from TUINNEL_CLOUDFLARED)` : `Version ${version} (managed)` };
  } catch {
    return { ok: false, detail: `${path} exists but does not run` };
  }
}

const PASS = chalk.green('PASS');
const FAIL = chalk.red('FAIL');

/** Like getToken() but returns null instead of throwing -- for diagnostics */
function findToken(): string | null {
  try {
    return getToken();
  } catch {
    return null;
  }
}

export async function doctorCommand(): Promise<void> {
  console.log('\ntuinnel-plus doctor\n');

  let passed = 0;
  let failed = 0;

  const checks: Check[] = [
    {
      name: 'Config file',
      run: async () => {
        if (configExists()) {
          try {
            const config = readConfig();
            if (config) {
              return { ok: true, detail: `Found at ${CONFIG_PATH}` };
            }
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, detail: `Invalid config: ${msg}` };
          }
        }
        return { ok: false, detail: `Not found at ${CONFIG_PATH}. Run \`tuinnel-plus init\`` };
      },
    },
    {
      name: 'API token',
      run: async () => {
        const token = findToken();
        if (!token) {
          return { ok: false, detail: 'No token found in config or environment. Run `tuinnel-plus init`' };
        }
        const source = (process.env.CLOUDFLARE_API_TOKEN || process.env.TUINNEL_API_TOKEN)
          ? 'environment variable'
          : 'config file';
        return { ok: true, detail: `Token found (${source}, ending ...${token.slice(-4)})` };
      },
    },
    {
      name: 'Token validates',
      run: async () => {
        const token = findToken();
        if (!token) {
          return { ok: false, detail: 'Skipped (no token)' };
        }
        const result = await validateToken(token);
        if (result.valid) {
          return { ok: true, detail: `Valid. Access to ${result.zones.length} zone${result.zones.length !== 1 ? 's' : ''}` };
        }
        return { ok: false, detail: result.error ?? 'Token is invalid' };
      },
    },
    {
      name: 'cloudflared binary',
      run: async () => checkCloudflared(),
    },
    {
      name: 'Network connectivity',
      run: async () => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
            signal: controller.signal,
            headers: { 'Authorization': 'Bearer test' },
          });
          clearTimeout(timeout);
          // We expect a 401 or similar — any response means network works
          return { ok: true, detail: `Cloudflare API reachable (HTTP ${res.status})` };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false, detail: `Cannot reach Cloudflare API: ${msg}` };
        }
      },
    },
  ];

  for (const check of checks) {
    const result = await check.run();
    const status = result.ok ? PASS : FAIL;
    console.log(`  ${status}  ${check.name}`);
    if (result.detail) {
      console.log(`         ${chalk.dim(result.detail)}`);
    }
    if (result.ok) passed++;
    else failed++;
  }

  console.log('');
  if (failed === 0) {
    console.log(chalk.green(`All ${passed} checks passed.`));
  } else {
    console.log(chalk.yellow(`${passed} passed, ${failed} failed.`));
  }
  console.log('');
}
