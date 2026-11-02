import type { DaemonClient } from '../client/daemon-client.js';
import { connectToDaemon } from '../client/connect.js';
import { logger } from '../utils/logger.js';

/** Delete a tunnel: stops it, removes it from Cloudflare and from config. */
export async function removeCommand(
  name: string,
  _options: Record<string, unknown>,
  getClient: () => Promise<DaemonClient> = connectToDaemon,
): Promise<void> {
  const client = await getClient();
  try {
    if (!client.get(name)) {
      logger.error(`Tunnel "${name}" not found.`);
      const names = Array.from(client.getAll().keys());
      console.error(names.length > 0 ? `\nConfigured tunnels: ${names.join(', ')}` : '\nNo tunnels configured.');
      process.exitCode = 1;
      return;
    }
    try {
      await client.delete(name);
      logger.success(`Removed tunnel "${name}"`);
    } catch (err) {
      // The tunnel is gone locally; some Cloudflare resources may remain.
      logger.warn(err instanceof Error ? err.message : String(err));
    }
  } finally {
    client.close();
  }
}
