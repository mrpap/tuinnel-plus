import { createInterface } from 'readline';
import { fileStore, getDefaultConfig, type ConfigStore } from '../config/store.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../daemon/auth.js';
import { connectIfRunning } from '../client/connect.js';
import { DaemonRequestError, type DaemonClient } from '../client/daemon-client.js';
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

function checkPassword(password: string, confirmation: string): string | null {
  if (password !== confirmation) return 'Passwords do not match.';
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  return null;
}

/** Store a new web UI password hash in the config file. Returns an error message, or null on success. */
export function setPassword(password: string, confirmation: string, store: ConfigStore = fileStore): string | null {
  const error = checkPassword(password, confirmation);
  if (error) return error;
  const config = store.read() ?? getDefaultConfig();
  config.web = { ...config.web, passwordHash: hashPassword(password) };
  store.write(config);
  return null;
}

/**
 * Set the password through a running service, which then owns the config write and signs
 * browsers out; without one, write the config file. Returns an error message, or null.
 */
export async function savePassword(
  password: string,
  confirmation: string,
  findClient: () => Promise<DaemonClient | null> = () => connectIfRunning({ history: false }),
): Promise<string | null> {
  const error = checkPassword(password, confirmation);
  if (error) return error;
  const client = await findClient();
  if (!client) {
    setPassword(password, confirmation);
    // A service that started while we wrote the file signs browsers out now, as it would have.
    const late = await findClient();
    if (late) {
      try {
        await late.reloadPassword();
      } catch {
        logger.warn('Browsers that were already signed in may stay signed in until the service restarts.');
      } finally {
        late.close();
      }
    }
    return null;
  }
  try {
    await client.setPassword(password);
  } catch (err) {
    // A service from before 0.1.5 has no such route: write the file and have it reload, as it expects.
    if (!(err instanceof DaemonRequestError) || err.status !== 404) throw err;
    setPassword(password, confirmation);
    try {
      await client.reloadPassword();
    } catch {
      // Saved either way: the service reads the hash on each sign-in.
      logger.warn('Browsers that were already signed in may stay signed in until the service restarts.');
    }
  } finally {
    client.close();
  }
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
  let error: string | null;
  try {
    error = await savePassword(password, confirmation);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  if (error) {
    logger.error(error);
    process.exitCode = 1;
    return;
  }
  logger.success('Password saved.');
}
