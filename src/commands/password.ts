import { createInterface } from 'readline';
import { fileStore, getDefaultConfig, type ConfigStore } from '../config/store.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../daemon/auth.js';
import { readDescriptor } from '../daemon/descriptor.js';
import { resolveStateDir } from '../config/paths.js';
import { logger } from '../utils/logger.js';

/** Read a line from stdin without echoing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void });
    process.stderr.write(question);
    write._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

/** Store a new web UI password hash. Returns an error message, or null on success. */
export function setPassword(password: string, confirmation: string, store: ConfigStore = fileStore): string | null {
  if (password !== confirmation) return 'Passwords do not match.';
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  const config = store.read() ?? getDefaultConfig();
  config.web = { ...config.web, passwordHash: hashPassword(password) };
  store.write(config);
  return null;
}

export async function passwordSetCommand(): Promise<void> {
  if (!process.stdin.isTTY) {
    logger.error('Run `tuinnel-plus password set` in an interactive terminal.');
    process.exitCode = 2;
    return;
  }

  const password = await askHidden('New web UI password: ');
  const confirmation = await askHidden('Repeat password: ');
  const error = setPassword(password, confirmation);
  if (error) {
    logger.error(error);
    process.exitCode = 1;
    return;
  }
  logger.success('Password saved.');

  // Tell a running daemon so it picks up the new hash and signs out old sessions.
  const d = readDescriptor(resolveStateDir());
  if (d) {
    try {
      await fetch(`http://${d.host}:${d.port}/api/settings/password/reload`, {
        method: 'POST',
        headers: { authorization: `Bearer ${d.localToken}` },
      });
    } catch {
      // Daemon not reachable — it reads the hash from config on each login anyway.
    }
  }
}
