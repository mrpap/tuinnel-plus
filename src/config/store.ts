import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { ConfigSchema, type Config } from './schema.js';
import { resolveStateDir } from './paths.js';

export const CONFIG_DIR = resolveStateDir();
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function readConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }

  const raw = readFileSync(CONFIG_PATH, 'utf-8');

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      `Corrupted config at ${CONFIG_PATH}: file is not valid JSON.\n` +
      `Delete the file and run \`tuinnel-plus init\` to reconfigure.`
    );
  }

  const result = ConfigSchema.safeParse(json);

  if (!result.success) {
    throw new Error(
      `Invalid config at ${CONFIG_PATH}: ${result.error.issues.map(i => i.message).join(', ')}`
    );
  }

  return result.data;
}

export function writeConfig(config: Config): void {
  // Validate before writing
  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid config: ${result.error.issues.map(i => i.message).join(', ')}`
    );
  }

  // Ensure config directory exists with restricted permissions
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    chmodSync(CONFIG_DIR, 0o700);
  }

  const tmpPath = CONFIG_PATH + '.tmp';
  const data = JSON.stringify(result.data, null, 2) + '\n';

  // Atomic write: write to .tmp, then rename
  writeFileSync(tmpPath, data, 'utf-8');
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, CONFIG_PATH);
}

/** Config persistence seam — lets services and tests swap the on-disk store. */
export interface ConfigStore {
  read(): Config | null;
  write(config: Config): void;
}

export const fileStore: ConfigStore = {
  read: () => readConfig(),
  write: (config) => writeConfig(config),
};

export function getDefaultConfig(): Config {
  return {
    version: 1,
    tunnels: {},
  };
}

export function getToken(): string {
  const envToken = process.env.CLOUDFLARE_API_TOKEN || process.env.TUINNEL_API_TOKEN;
  if (envToken) return envToken;

  const config = readConfig();
  if (config?.apiToken) return config.apiToken;

  throw new Error(
    'error: No API token configured\n\nRun `tuinnel-plus init` to set up your account, or set CLOUDFLARE_API_TOKEN.'
  );
}
