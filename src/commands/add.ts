import type { DaemonClient } from '../client/daemon-client.js';
import { connectIfRunning } from '../client/connect.js';
import { addTunnelToConfig, resolveNewTunnel } from '../config/tunnel-config.js';
import { readConfig } from '../config/store.js';
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
  findClient: () => Promise<DaemonClient | null> = () => connectIfRunning({ history: false }),
): Promise<void> {
  try {
    const port = validatePort(portStr)!;

    // A running service creates the tunnel (in Cloudflare too) and saves it: it is the only
    // writer of the config while it runs. Don't start one just for this.
    const client = await findClient();
    if (client) {
      try {
        // The service re-reads the file and token first: tunnels added there by hand, and a
        // token set with `init` since it started, count.
        await client.reload();
        const { name, config } = await resolveNewTunnel({ port, ...options }, readConfig()?.defaultZone);
        const existing = client.get(name);
        if (existing) {
          throw new Error(
            `Tunnel "${name}" already exists (port ${existing.config.port}). ` +
            `Use \`tuinnel-plus remove ${name}\` first, or choose a different subdomain.`,
          );
        }
        await client.create({ port, subdomain: config.subdomain, zone: config.zone });
        logger.success(`Added tunnel "${name}" — ${config.subdomain}.${config.zone} <- :${port}`);
        const sharing = [...client.getAll().values()].find((t) => t.name !== name && t.config.port === port);
        if (sharing) logger.warn(`Port ${port} is also used by "${sharing.name}"; \`tuinnel-plus up ${port}\` starts that one first.`);
        logger.info(`Created the Cloudflare tunnel and DNS record. Run \`tuinnel-plus up ${port}\` to start it.`);
      } finally {
        client.close();
      }
      return;
    }

    const result = await addTunnelToConfig({
      port,
      subdomain: options.subdomain,
      zone: options.zone,
      failOnDuplicate: true,
    });

    logger.success(`Added tunnel "${result.name}" — ${result.config.subdomain}.${result.config.zone} <- :${port}`);

    // A service that started while we wrote the file reads it now rather than missing the tunnel.
    const late = await findClient();
    if (late) {
      try {
        await late.reload();
      } catch {
        logger.warn('The background service did not confirm it read the new tunnel. Run `tuinnel-plus up` to start it anyway.');
      } finally {
        late.close();
      }
    }
    console.error('\nThis saves configuration only. Run `tuinnel-plus up` to start the tunnel.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(msg);
    process.exitCode = 1;
  }
}
