import Table from 'cli-table3';
import { readConfig } from '../config/store.js';
import { getRunningTunnels } from '../cloudflared/pid.js';
import { probePort } from '../utils/port-probe.js';
import { logger } from '../utils/logger.js';
import type { DaemonClient } from '../client/daemon-client.js';
import { connectIfRunning } from '../client/connect.js';

interface TunnelStatus {
  name: string;
  publicUrl: string;
  localPort: number;
  status: string; // runtime state, or 'port_down' when the local port is closed
  pid: number;
}

export async function statusCommand(
  options: { json?: boolean },
  findClient: () => Promise<DaemonClient | null> = connectIfRunning,
): Promise<void> {
  const client = await findClient();
  if (client) {
    try {
      printStatuses(await statusesFromDaemon(client), options);
    } finally {
      client.close();
    }
    return;
  }

  // No background service: fall back to the PID file.
  const running = getRunningTunnels();

  if (running.length === 0) {
    if (options.json) {
      process.stdout.write('[]\n');
      return;
    }
    logger.info('No tunnels currently running. Start one with `tuinnel-plus up`.');
    return;
  }

  const config = readConfig();
  const statuses: TunnelStatus[] = [];

  for (const { name, pid } of running) {
    const tunnelConfig = config?.tunnels[name];
    const port = tunnelConfig?.port ?? 0;
    const publicUrl = tunnelConfig
      ? `https://${tunnelConfig.subdomain}.${tunnelConfig.zone}`
      : 'unknown';

    let status: TunnelStatus['status'] = 'connected';
    if (port > 0) {
      const portAlive = await probePort(port);
      if (!portAlive) {
        status = 'port_down';
      }
    }

    statuses.push({ name, publicUrl, localPort: port, status, pid });
  }

  printStatuses(statuses, options);
}

/** Non-stopped tunnels as the background service reports them. */
async function statusesFromDaemon(client: DaemonClient): Promise<TunnelStatus[]> {
  const statuses: TunnelStatus[] = [];
  for (const t of client.getAll().values()) {
    if (t.state === 'stopped') continue;
    let status: TunnelStatus['status'] = t.state;
    if (t.state === 'connected' && !(await probePort(t.config.port))) status = 'port_down';
    statuses.push({
      name: t.name,
      publicUrl: t.publicUrl ?? `https://${t.config.subdomain}.${t.config.zone}`,
      localPort: t.config.port,
      status,
      pid: t.pid ?? 0,
    });
  }
  return statuses;
}

function printStatuses(statuses: TunnelStatus[], options: { json?: boolean }): void {
  if (statuses.length === 0 && !options.json) {
    logger.info('No tunnels currently running. Start one with `tuinnel-plus up`.');
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(statuses, null, 2) + '\n');
    return;
  }

  const table = new Table({
    head: ['Name', 'Public URL', 'Port', 'Status', 'PID'],
    style: { head: ['cyan'] },
  });

  for (const s of statuses) {
    const statusLabel = s.status === 'port_down' ? 'port down' : s.status;

    table.push([
      s.name,
      s.publicUrl,
      String(s.localPort),
      statusLabel,
      String(s.pid),
    ]);
  }

  console.log(table.toString());
}
