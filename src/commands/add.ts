import type { DaemonClient } from '../client/daemon-client.js';
import { connectIfRunning } from '../client/connect.js';
import { addTunnelToConfig } from '../config/tunnel-config.js';
import { logger } from '../utils/logger.js';
import { validatePort } from '../utils/validation.js';

interface AddOptions {
  subdomain?: string;
  zone?: string;
  verbose?: boolean;
}

export async function addCommand(
  portStr: string,
  options: AddOptions,
  findClient: () => Promise<DaemonClient | null> = connectIfRunning,
): Promise<void> {
  try {
    const port = validatePort(portStr)!;

    const result = await addTunnelToConfig({
      port,
      subdomain: options.subdomain,
      zone: options.zone,
      failOnDuplicate: true,
    });

    logger.success(`Added tunnel "${result.name}" — ${result.config.subdomain}.${result.config.zone} <- :${port}`);

    // A running background service picks up the new tunnel; don't start one just for this.
    const client = await findClient();
    if (client) {
      try {
        await client.reload();
      } finally {
        client.close();
      }
    }
    console.error('\nThis saves configuration only. Run `tuinnel-plus up` to start the tunnel.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(msg);
    process.exitCode = 1;
  }
}
