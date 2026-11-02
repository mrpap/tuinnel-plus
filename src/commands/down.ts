import type { DaemonClient } from '../client/daemon-client.js';
import { connectToDaemon } from '../client/connect.js';
import { logger } from '../utils/logger.js';
import { confirm } from '../utils/prompt.js';

interface DownOptions {
  clean?: boolean;
  all?: boolean;
}

export async function downCommand(
  names: string[],
  options: DownOptions,
  getClient: () => Promise<DaemonClient> = connectToDaemon,
): Promise<void> {
  const client = await getClient();
  try {
    await stopTunnels(client, names, options);
  } finally {
    client.close();
  }
}

async function stopTunnels(client: DaemonClient, names: string[], options: DownOptions): Promise<void> {
  const running = Array.from(client.getAll().values())
    .filter((t) => t.state !== 'stopped')
    .map((t) => t.name);

  // --clean on a named, already-stopped tunnel still deletes it.
  const known = options.clean ? Array.from(client.getAll().keys()) : running;

  if (known.length === 0) {
    logger.info('No tunnels are currently running.');
    return;
  }

  let tunnelsToStop: string[];

  if (names.length > 0) {
    // Stop specific named tunnels
    tunnelsToStop = [];
    for (const name of names) {
      if (!known.includes(name)) {
        logger.error(`Tunnel '${name}' is not running.`);
        continue;
      }
      tunnelsToStop.push(name);
    }
  } else if (options.all) {
    // Stop all tunnels, no confirmation
    tunnelsToStop = running;
  } else if (!process.stdin.isTTY) {
    // Non-interactive, no names, no --all flag
    logger.error(
      'No tunnel names specified.\n\n' +
      'In non-interactive mode, specify tunnel names or use --all:\n' +
      '  tuinnel-plus down myapp\n' +
      '  tuinnel-plus down --all'
    );
    process.exitCode = 2;
    return;
  } else {
    // Interactive: prompt user
    const confirmed = await confirm(
      `Stop all ${running.length} running tunnel(s)? (${running.join(', ')}) (y/N) `
    );
    if (!confirmed) {
      logger.info('Cancelled.');
      return;
    }
    tunnelsToStop = running;
  }

  for (const name of tunnelsToStop) {
    try {
      if (running.includes(name)) {
        await client.stop(name);
        logger.success(`Stopped tunnel '${name}'`);
      }
      if (options.clean) {
        await client.delete(name);
        logger.success(`Deleted tunnel '${name}' from Cloudflare and config`);
      }
    } catch (err) {
      logger.warn(err instanceof Error ? err.message : String(err));
    }
  }
}
