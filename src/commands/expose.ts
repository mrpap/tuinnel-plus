import type { DaemonClient } from '../client/daemon-client.js';
import { connectToDaemon } from '../client/connect.js';
import { configExists, readConfig } from '../config/store.js';
import { logger } from '../utils/logger.js';

interface ExposeOptions {
  subdomain?: string;
  zone?: string;
  off?: boolean;
}

/** Publish (or unpublish) the web UI through a Cloudflare tunnel. */
export async function exposeCommand(
  options: ExposeOptions,
  getClient: () => Promise<DaemonClient> = connectToDaemon,
): Promise<void> {
  const zone = options.zone ?? (configExists() ? readConfig()?.defaultZone : undefined);
  if (!options.off && (!options.subdomain || !zone)) {
    logger.error(
      !options.subdomain
        ? 'Pass --subdomain <name> for the web UI address, e.g. `tuinnel-plus expose --subdomain admin`.'
        : 'Pass --zone <domain>: no default zone is configured.',
    );
    process.exitCode = 1;
    return;
  }

  const client = await getClient();
  try {
    if (options.off) {
      await client.setSelfExpose({ enabled: false });
      logger.success('Web UI is no longer exposed through Cloudflare.');
      return;
    }
    const res = await client.setSelfExpose({ enabled: true, subdomain: options.subdomain, zone });
    logger.success(`Web UI exposed at ${res.url}`);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    client.close();
  }
}
