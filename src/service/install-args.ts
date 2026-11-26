import { realpathSync } from 'fs';

/** How to re-run this exact install: the current runtime + entry script + `serve`. */
export function programArgsForCurrentInstall(): string[] {
  return [process.execPath, realpathSync(process.argv[1]), 'serve'];
}

/** Environment the agent needs: state dir, which cloudflared to run, PATH, and a token if one came from env. */
export function serviceEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['TUINNEL_HOME', 'TUINNEL_CLOUDFLARED', 'PATH', 'CLOUDFLARE_API_TOKEN', 'TUINNEL_API_TOKEN']) {
    const v = env[key];
    if (v) out[key] = v;
  }
  return out;
}
