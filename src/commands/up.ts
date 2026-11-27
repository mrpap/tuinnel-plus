import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { readConfig, configExists, getToken as getTokenOrThrow } from '../config/store.js';
import { resolveNewTunnel } from '../config/tunnel-config.js';
import { ensureBinary } from '../cloudflared/binary.js';
import { extractQuickTunnelUrl } from '../cloudflared/log-parser.js';
import { logger } from '../utils/logger.js';
import { resolveLoopback } from '../utils/port-probe.js';
import { validatePort } from '../utils/validation.js';
import { launchTui } from '../tui/launch.js';
import type { DaemonClient } from '../client/daemon-client.js';
import { connectToDaemon } from '../client/connect.js';
import type { TunnelConfig } from '../config/schema.js';

interface UpOptions {
  quick?: boolean;
  tui?: boolean;       // true by default, false with --no-tui
  verbose?: boolean;
  subdomain?: string;
  zone?: string;
}

/** Returns token or null (for quick-tunnel fallback) */
function getToken(): string | null {
  try {
    return getTokenOrThrow();
  } catch {
    return null;
  }
}

// -- Quick tunnel mode --

async function runQuickTunnels(ports: number[], binaryPath: string): Promise<void> {
  const quickProcesses: Array<{ port: number; child: ReturnType<typeof spawn> }> = [];

  // Graceful shutdown handler
  const shutdown = async () => {
    for (const { child } of quickProcesses) {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
    }
    // Wait briefly for graceful exit
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const { child } of quickProcesses) {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  for (const port of ports) {
    const host = await resolveLoopback(port);
    const child = spawn(binaryPath, ['tunnel', '--config', '/dev/null', '--url', `http://${host}:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    quickProcesses.push({ port, child });

    // Parse stderr for the quick tunnel URL
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on('line', (line) => {
        const url = extractQuickTunnelUrl(line);
        if (url) {
          logger.success(`${url} <- :${port}`);
        }
        process.stderr.write(`[port:${port}] ${line}\n`);
      });
      child.stderr.on('error', () => {});
    }

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        logger.error(`Quick tunnel on port ${port} exited with code ${code}`);
      }
    });
  }

  logger.info('Quick tunnel(s) starting... Press Ctrl+C to stop.');

  // Keep process alive until all children exit or signal received
  await new Promise<void>((resolve) => {
    let exited = 0;
    for (const { child } of quickProcesses) {
      child.on('exit', () => {
        exited++;
        if (exited >= quickProcesses.length) {
          resolve();
        }
      });
    }
  });
}

// -- Named tunnel mode --

async function runNamedTunnels(
  ports: number[],
  options: UpOptions,
  getClient: () => Promise<DaemonClient>,
): Promise<void> {
  // The background service owns the tunnels and the config: look tunnels up in it, and have
  // it create new ones (in Cloudflare too) rather than writing the config file here.
  const client = await getClient();
  let started = 0;
  try {
    // Read-only for the file: the service adds tunnels it finds there but doesn't know yet
    // (hand edits, an older CLI, or an `add` that ran while the service was starting).
    await client.reload();
    const created = new Map<string, TunnelConfig>();
    const defaultZone = (configExists() ? readConfig() : null)?.defaultZone;
    const tunnelsToStart: Array<{ name: string; tunnelConfig: TunnelConfig }> = [];
    for (const port of ports) {
      const known = [...client.getAll().values()].find((t) => t.config.port === port);
      if (known) {
        tunnelsToStart.push({ name: known.name, tunnelConfig: known.config });
        continue;
      }
      const { name, config } = await resolveNewTunnel({ port, subdomain: options.subdomain, zone: options.zone }, defaultZone);
      // Created a moment ago in this loop: the service's event about it may not be in yet.
      const existing = client.get(name)?.config ?? created.get(name);
      if (existing) {
        // Same name already set up (on another port): start that one, as before.
        if (!tunnelsToStart.some((t) => t.name === name)) tunnelsToStart.push({ name, tunnelConfig: existing });
        continue;
      }
      try {
        await client.create({ port, subdomain: config.subdomain, zone: config.zone });
        created.set(name, config);
        tunnelsToStart.push({ name, tunnelConfig: config });
      } catch (err: unknown) {
        logger.error(`Failed to create tunnel "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const total = tunnelsToStart.length;
    for (let i = 0; i < total; i++) {
      const { name, tunnelConfig } = tunnelsToStart[i];
      const url = `https://${tunnelConfig.subdomain}.${tunnelConfig.zone}`;
      try {
        await client.start(name);
        started++;
        logger.success(`${url} <- :${tunnelConfig.port}  (${i + 1}/${total})`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already running')) {
          started++;
          logger.info(`${url} <- :${tunnelConfig.port} is already running`);
        } else {
          logger.error(`Failed to start tunnel "${name}": ${msg}`);
        }
      }
    }
  } catch (err) {
    client.close();
    throw err;
  }

  if (started === 0) {
    client.close();
    logger.error('No tunnels started successfully.');
    process.exitCode = 1;
    return;
  }

  const useTui = options.tui !== false
    && (process.stdout.isTTY ?? false)
    && (process.stdin.isTTY ?? false);

  if (useTui) {
    // The TUI takes over the connection and closes it on quit.
    await launchTui({ initialMode: 'dashboard', connect: async () => client });
  } else {
    client.close();
    logger.info('Tunnels keep running in the background service. Stop them with `tuinnel-plus down`.');
  }
}

// -- Main entry point --

export async function upCommand(
  ports: string[],
  options: UpOptions,
  getClient: () => Promise<DaemonClient> = connectToDaemon,
): Promise<void> {
  if (ports.length === 0) {
    logger.error('No ports specified.\n\nUsage: tuinnel-plus up <port> [port...]');
    process.exitCode = 1;
    return;
  }

  const parsedPorts = ports.map(p => validatePort(p)!);
  const token = getToken();
  const useQuick = options.quick || !token;

  if (useQuick) {
    // Quick tunnels run in this process, not in the background service.
    const binaryPath = await ensureBinary();
    if (!options.quick && !token) {
      logger.info(
        'No API token configured. Running as quick tunnel (random subdomain).\n' +
        'For custom domains, run `tuinnel-plus init` first.',
      );
    }
    await runQuickTunnels(parsedPorts, binaryPath);
  } else {
    await runNamedTunnels(parsedPorts, options, getClient);
  }
}
