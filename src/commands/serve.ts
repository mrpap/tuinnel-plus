import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import { fileStore, type ConfigStore } from '../config/store.js';
import { resolveStateDir } from '../config/paths.js';
import { webSettings } from '../config/web.js';
import { TunnelService, type PidOps } from '../services/tunnel-service.js';
import { findOrphans, purgeOrphans } from '../services/purge.js';
import { getAllZones } from '../cloudflare/api.js';
import { scrapeMetrics } from '../metrics/prometheus.js';
import { createDaemonServer } from '../daemon/server.js';
import { SseHub } from '../daemon/sse.js';
import { acquireLock, releaseLock, writeDescriptor, DaemonRunningError } from '../daemon/descriptor.js';
import { reclaimExternal } from '../daemon/reclaim.js';
import { keepAutoStarting, AUTOSTART_RETRY_DELAYS_MS } from '../daemon/autostart.js';
import { createGuard } from '../daemon/guard.js';
import { resolveAssetsDir } from '../daemon/static.js';
import { SelfExpose, type SelfExposeStatus } from '../daemon/self-expose.js';
import { RateLimiter, SessionStore } from '../daemon/auth.js';
import { VERSION } from '../version.js';
import { logger } from '../utils/logger.js';

export interface StartDaemonOptions {
  port?: number;
  host?: string;
  stateDir?: string;
  store?: ConfigStore;
  /** Cloudflare API token; defaults to env, then config. */
  token?: string;
  pids?: PidOps;
  reclaim?: (store: ConfigStore) => Promise<string[]>;
  autoStart?: boolean;
  /** Backoff between auto-start retries; injectable for tests. */
  autoStartRetryDelaysMs?: number[];
  log?: (msg: string) => void;
}

export interface RunningDaemon {
  port: number;
  host: string;
  localToken: string;
  service: TunnelService;
  sessions: SessionStore;
  stop(): Promise<void>;
}

function tokenFrom(store: ConfigStore): string {
  return process.env.CLOUDFLARE_API_TOKEN || process.env.TUINNEL_API_TOKEN || store.read()?.apiToken || '';
}

/** Host header values the daemon answers to: loopback names, the bind address, and the self-expose hostname. */
export function allowedHostsFor(host: string, port: number, selfExpose: SelfExposeStatus): string[] {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${host}:${port}`];
  if (selfExpose.enabled && selfExpose.subdomain && selfExpose.zone) {
    hosts.push(`${selfExpose.subdomain}.${selfExpose.zone}`);
  }
  return hosts;
}

/** Start the daemon in-process. serveCommand wraps this with signals and exit codes. */
export async function startDaemon(opts: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const stateDir = opts.stateDir ?? resolveStateDir();
  const store = opts.store ?? fileStore;
  const log = opts.log ?? ((msg: string) => logger.info(msg));
  const settings = webSettings(store.read());
  const host = opts.host ?? settings.host;
  const wantedPort = opts.port ?? settings.port;

  acquireLock(stateDir);
  try {
    let token = opts.token ?? tokenFrom(store);

    // Without a token we couldn't restart reclaimed tunnels, so leave them running.
    if (token) {
      const reclaimed = await (opts.reclaim ?? reclaimExternal)(store);
      for (const name of reclaimed) log(`Took over running tunnel "${name}" — restarting it under the service`);
    }

    const service = new TunnelService(token, store, opts.pids);
    service.loadFromConfig();

    const localToken = randomBytes(32).toString('hex');
    const startedAt = Date.now();
    let port = wantedPort;

    const sessions = new SessionStore();
    // The self-expose tunnel points at the port we actually bind, set after listen.
    let selfExpose = new SelfExpose(service, store, wantedPort);
    const isSystemTunnel = (name: string) => selfExpose.isSystemTunnel(name);
    const hub = new SseHub(service, { isSystemTunnel });
    const { server } = createDaemonServer({
      service,
      guard: createGuard({ localToken, sessions }),
      auth: { store, sessions, limiter: new RateLimiter() },
      allowedHosts: () => allowedHostsFor(host, port, selfExpose.status()),
      isSystemTunnel,
      get selfExpose() { return selfExpose; },
      listenInfo: () => ({ port, host }),
      hub,
      assetsDir: resolveAssetsDir(),
      zones: async () => (await getAllZones(token)).map((z) => ({ id: z.id, name: z.name })),
      purge: {
        preview: async () => {
          const { accountId: _accountId, ...plan } = await findOrphans(token, store);
          return plan;
        },
        // Re-scan so only ids that are still orphans can be deleted
        run: async (ids) => {
          const plan = await findOrphans(token, store);
          const wanted = new Set(ids);
          return purgeOrphans({ ...plan, orphaned: plan.orphaned.filter((t) => wanted.has(t.id)) }, token);
        },
      },
      reload: async () => {
        token = tokenFrom(store);
        service.setToken(token);
        service.loadFromConfig();
      },
      scrape: scrapeMetrics,
      statusInfo: () => {
        const se = selfExpose.status();
        return { version: VERSION, startedAt, selfExpose: { enabled: se.enabled, url: se.url } };
      },
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(wantedPort, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    port = (server.address() as AddressInfo).port;
    selfExpose = new SelfExpose(service, store, port);

    writeDescriptor(stateDir, { pid: process.pid, host, port, localToken, version: VERSION, startedAt });

    let stopped = false;
    if (opts.autoStart !== false && token) {
      const attempt = async () => {
        const failed = await service.autoStart();
        try {
          await selfExpose.ensure();
        } catch (err) {
          log(`Self-expose failed: ${err instanceof Error ? err.message : String(err)}`);
          failed.push('web UI');
        }
        return failed;
      };
      keepAutoStarting(attempt, {
        delaysMs: opts.autoStartRetryDelaysMs ?? AUTOSTART_RETRY_DELAYS_MS,
        isStopped: () => stopped,
        log,
      }).catch((err) => log(`Auto-start failed: ${err instanceof Error ? err.message : String(err)}`));
      if (selfExpose.status().enabled && !store.read()?.web?.passwordHash) {
        log('Self-expose is enabled but no password is set — the admin UI stays local. Run `tuinnel-plus password set`.');
      }
    }

    return {
      port,
      host,
      localToken,
      service,
      sessions,
      async stop() {
        if (stopped) return;
        stopped = true;
        hub.close();
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await service.shutdown();
        releaseLock(stateDir);
      },
    };
  } catch (err) {
    releaseLock(stateDir);
    throw err;
  }
}

export async function serveCommand(opts: { port?: number; host?: string }): Promise<void> {
  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon(opts);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') {
      logger.error(`Port ${opts.port ?? webSettings(fileStore.read()).port} is in use. Pass --port or set web.port.`);
    } else if (err instanceof DaemonRunningError) {
      logger.error(err.message);
    } else {
      logger.error(e.message ?? String(err));
    }
    process.exit(1);
  }

  logger.info(`tuinnel-plus daemon listening on http://${daemon.host}:${daemon.port}`);

  const shutdown = async () => {
    logger.info('Shutting down — tunnels will come back on next start.');
    await daemon.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
