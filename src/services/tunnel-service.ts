import { EventEmitter } from 'events';
import type { TunnelConfig } from '../config/schema.js';
import type { TunnelRuntime, TunnelState } from '../types.js';
import type { CloudflaredProcess } from '../cloudflared/process.js';
import { spawnCloudflared } from '../cloudflared/process.js';
import { ensureBinary } from '../cloudflared/binary.js';
import { writePid, removePid } from '../cloudflared/pid.js';
import {
  createOrGetTunnel,
  updateIngress,
  createOrVerifyDns,
  deleteTunnelResources,
} from '../cloudflare/tunnel-manager.js';
import {
  discoverAccountId,
  getAllZones,
} from '../cloudflare/api.js';
import { fileStore, type ConfigStore } from '../config/store.js';
import { parseLogLine, extractRegistration, extractMetricsAddr } from '../cloudflared/log-parser.js';
import type { ConnectionEvent } from '../types.js';
import { logger } from '../utils/logger.js';
import { resolveLoopback } from '../utils/port-probe.js';

const MAX_EVENTS = 1000;

export interface TunnelServiceEvents {
  stateChange: { name: string; state: TunnelState; tunnel: TunnelRuntime };
  tunnelAdded: { name: string; tunnel: TunnelRuntime };
  tunnelRemoved: { name: string };
}

/** Pid-file operations, injectable so tests never touch the real pid file. */
export interface PidOps {
  write(name: string, pid: number): void;
  remove(name: string): void;
}

const filePids: PidOps = { write: writePid, remove: removePid };

export interface ProvisionSpec {
  name: string;
  subdomain: string;
  zone: string;
  port: number;
  protocol: 'http' | 'https';
  tunnelId?: string | null;
  connectorToken?: string | null;
}

/** Everything that talks to Cloudflare or spawns cloudflared, injectable for tests. */
export interface CloudflareOps {
  /**
   * Make sure the Cloudflare tunnel, its ingress rule and its DNS record exist.
   * With `strictZone`, an unknown zone fails before anything is created;
   * otherwise it only skips the DNS record.
   */
  provision(spec: ProvisionSpec, token: string, opts: { strictZone: boolean }): Promise<{ tunnelId: string; connectorToken: string }>;
  /** Delete the tunnel and its DNS record. Returns problems instead of throwing. */
  deprovision(name: string, target: { subdomain: string; zone: string }, token: string, tunnelId: string | null): Promise<string[]>;
  launch(connectorToken: string): Promise<CloudflaredProcess>;
}

export const cloudflareOps: CloudflareOps = {
  async provision(spec, token, { strictZone }) {
    const accountId = await discoverAccountId(token);
    const hostname = `${spec.subdomain}.${spec.zone}`;

    const zones = await getAllZones(token);
    const zoneObj = zones.find((z) => z.name === spec.zone);
    if (!zoneObj && strictZone) {
      throw new Error(
        `Zone "${spec.zone}" not found in your Cloudflare account.\n` +
        `Available zones: ${zones.map((z) => z.name).join(', ') || '(none)'}`,
      );
    }

    let { tunnelId, connectorToken } = spec;
    if (!tunnelId || !connectorToken) {
      ({ tunnelId, connectorToken } = await createOrGetTunnel(accountId, spec.name, token));
    }

    // Always rewrite the ingress rule, to correct any drift
    const loopback = await resolveLoopback(spec.port);
    await updateIngress(accountId, tunnelId, hostname, spec.port, spec.protocol, token, loopback);

    if (zoneObj) {
      await createOrVerifyDns(zoneObj.id, hostname, tunnelId, token);
    } else {
      logger.warn(`Zone "${spec.zone}" not found — DNS record may be missing`);
    }
    return { tunnelId, connectorToken };
  },

  async deprovision(name, target, token, tunnelId) {
    const result = await deleteTunnelResources(name, target, token, tunnelId);
    return result.warnings;
  },

  async launch(connectorToken) {
    return spawnCloudflared(await ensureBinary(), connectorToken);
  },
};

/** Thrown by delete() when the tunnel was removed locally but Cloudflare cleanup was incomplete. */
export class PartialDeleteError extends Error {
  constructor(public readonly tunnelName: string, public readonly warnings: string[]) {
    super(
      `Removed "${tunnelName}", but some Cloudflare resources may remain: ${warnings.join('; ')}. ` +
      `Run \`tuinnel-plus purge\` to retry.`,
    );
    this.name = 'PartialDeleteError';
  }
}

export interface CreateOptions {
  port: number;
  subdomain: string;
  zone: string;
  protocol?: 'http' | 'https';
}

function makeRuntime(name: string, config: TunnelConfig): TunnelRuntime {
  return {
    name,
    config,
    state: 'stopped',
    pid: null,
    tunnelId: config.tunnelId ?? null,
    publicUrl: `https://${config.subdomain}.${config.zone}`,
    connectorToken: null,
    metricsPort: null,
    connectedAt: 0,
    lastError: null,
    connections: [],
  };
}

export class TunnelService extends EventEmitter {
  private tunnels = new Map<string, TunnelRuntime>();
  private processes = new Map<string, CloudflaredProcess>();
  /** Tunnels being stopped on purpose, so their exit isn't reported as an error. */
  private stopping = new Set<string>();
  private token: string;
  private store: ConfigStore;
  private pids: PidOps;
  private cf: CloudflareOps;

  constructor(token: string, store: ConfigStore = fileStore, pids: PidOps = filePids, cf: CloudflareOps = cloudflareOps) {
    super();
    this.token = token;
    this.store = store;
    this.pids = pids;
    this.cf = cf;
  }

  setToken(token: string): void {
    this.token = token;
  }

  // -- Query --

  getAll(): Map<string, TunnelRuntime> {
    return new Map(this.tunnels);
  }

  get(name: string): TunnelRuntime | undefined {
    return this.tunnels.get(name);
  }

  // -- Lifecycle --

  async create(opts: CreateOptions): Promise<string> {
    const { port, subdomain, zone, protocol = 'http' } = opts;
    const name = subdomain; // Use subdomain as tunnel name

    if (this.tunnels.has(name)) {
      throw new Error(`Tunnel "${name}" already exists`);
    }

    const config: TunnelConfig = { port, subdomain, zone, protocol, lastState: 'stopped' };
    const runtime = makeRuntime(name, config);
    this.setState(name, runtime, 'creating');

    try {
      const { tunnelId, connectorToken } = await this.cf.provision(
        { name, subdomain, zone, port, protocol }, this.token, { strictZone: true },
      );
      runtime.tunnelId = tunnelId;
      runtime.connectorToken = connectorToken;

      // Save to config
      config.tunnelId = tunnelId;
      this.persistTunnel(name, config);

      this.tunnels.set(name, runtime);
      this.setState(name, runtime, 'stopped');
      this.emit('tunnelAdded', { name, tunnel: runtime });

      return name;
    } catch (err) {
      this.tunnels.delete(name);
      throw err;
    }
  }

  async update(name: string, changes: Partial<Pick<CreateOptions, 'port' | 'subdomain' | 'zone' | 'protocol'>>): Promise<void> {
    const runtime = this.tunnels.get(name);
    if (!runtime) {
      throw new Error(`Tunnel "${name}" not found`);
    }

    const needsRecreate = (changes.subdomain && changes.subdomain !== runtime.config.subdomain) ||
      (changes.zone && changes.zone !== runtime.config.zone);

    // Update config fields
    const updatedConfig: TunnelConfig = {
      ...runtime.config,
      ...changes,
    };

    if (needsRecreate) {
      const newName = updatedConfig.subdomain;
      if (newName !== name && this.tunnels.has(newName)) {
        throw new Error(`Tunnel "${newName}" already exists`);
      }

      // Stop, delete CF resources, recreate
      const wasRunning = runtime.state === 'connected' || runtime.state === 'connecting';
      if (this.processes.has(name)) {
        await this.stop(name);
      }
      await this.deleteCloudflareResources(name, runtime);
      this.tunnels.delete(name);
      if (newName !== name) {
        this.removeTunnelFromConfig(name);
        this.emit('tunnelRemoved', { name });
      }

      await this.create({
        port: updatedConfig.port,
        subdomain: updatedConfig.subdomain,
        zone: updatedConfig.zone,
        protocol: updatedConfig.protocol,
      });

      if (wasRunning) {
        await this.start(newName);
      }
    } else {
      // Simple config update (port or protocol change)
      runtime.config = updatedConfig;
      this.persistTunnel(name, updatedConfig);

      // If running, restart to pick up changes
      if (this.processes.has(name)) {
        await this.restart(name);
      }
    }
  }

  async delete(name: string): Promise<void> {
    const runtime = this.tunnels.get(name);
    if (!runtime) {
      throw new Error(`Tunnel "${name}" not found`);
    }

    // Stop process if running
    if (this.processes.has(name)) {
      await this.stop(name);
    }

    // Delete CF resources (best-effort — collect any problems rather than abort)
    const warnings = await this.deleteCloudflareResources(name, runtime);

    // Remove locally regardless: the user asked for it gone, and leaving a
    // half-deleted entry behind would be worse than a Cloudflare orphan.
    this.removeTunnelFromConfig(name);
    this.tunnels.delete(name);
    this.emit('tunnelRemoved', { name });

    // Surface incomplete Cloudflare cleanup so orphans aren't silent.
    if (warnings.length > 0) {
      throw new PartialDeleteError(name, warnings);
    }
  }

  async start(name: string): Promise<void> {
    const runtime = this.tunnels.get(name);
    if (!runtime) {
      throw new Error(`Tunnel "${name}" not found`);
    }

    if (this.processes.has(name)) {
      throw new Error(`Tunnel "${name}" is already running`);
    }

    runtime.lastError = null;
    this.setState(name, runtime, 'connecting');

    try {
      const { tunnelId, connectorToken } = await this.cf.provision(
        { name, ...runtime.config, tunnelId: runtime.tunnelId, connectorToken: runtime.connectorToken },
        this.token,
        { strictZone: false },
      );
      runtime.tunnelId = tunnelId;
      runtime.connectorToken = connectorToken;

      const proc = await this.cf.launch(connectorToken);
      this.processes.set(name, proc);

      if (proc.pid) {
        this.pids.write(name, proc.pid);
        runtime.pid = proc.pid;
      }

      this.wireProcess(name, proc, runtime);

      // Update persisted state
      this.persistTunnelState(name, 'running');
    } catch (err) {
      runtime.lastError = err instanceof Error ? err.message : String(err);
      this.setState(name, runtime, 'error');
      throw err;
    }
  }

  async stop(name: string): Promise<void> {
    await this.stopProcess(name, { persist: true });
  }

  /**
   * Kill a tunnel's process. `persist: false` leaves the saved lastState alone,
   * for shutdown() and restart().
   */
  private async stopProcess(name: string, opts: { persist: boolean }): Promise<void> {
    const runtime = this.tunnels.get(name);
    if (!runtime) {
      throw new Error(`Tunnel "${name}" not found`);
    }

    const proc = this.processes.get(name);
    if (!proc) {
      this.setState(name, runtime, 'stopped');
      return;
    }

    this.stopping.add(name);
    try {
      await proc.kill();
    } finally {
      this.stopping.delete(name);
    }
    this.processes.delete(name);
    this.pids.remove(name);
    runtime.pid = null;
    runtime.metricsPort = null;
    runtime.connectedAt = 0;
    this.setState(name, runtime, 'stopped');
    if (opts.persist) this.persistTunnelState(name, 'stopped');
  }

  async restart(name: string): Promise<void> {
    const runtime = this.tunnels.get(name);
    if (!runtime) {
      throw new Error(`Tunnel "${name}" not found`);
    }

    this.setState(name, runtime, 'restarting');
    // A restart isn't a user stop: if start fails, auto-start should still retry it
    await this.stopProcess(name, { persist: false });
    await this.start(name);
  }

  // -- Batch operations --

  loadFromConfig(): void {
    const config = this.store.read();
    if (!config) return;

    for (const [name, tunnelConfig] of Object.entries(config.tunnels)) {
      if (!this.tunnels.has(name)) {
        const runtime = makeRuntime(name, tunnelConfig);
        this.tunnels.set(name, runtime);
      }
    }
  }

  /** Start every tunnel whose lastState is running and isn't up. Returns the ones that failed. */
  async autoStart(): Promise<string[]> {
    const failed: string[] = [];
    for (const [name, runtime] of this.tunnels) {
      if (runtime.config.lastState === 'running' && !this.processes.has(name)) {
        try {
          await this.start(name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`Failed to auto-start tunnel "${name}": ${msg}`);
          failed.push(name);
        }
      }
    }
    return failed;
  }

  /**
   * Stop every process without touching lastState: it records user intent
   * (written by start/stop), so a daemon restart brings the same tunnels back —
   * including ones that happened to be down at shutdown.
   */
  async shutdown(): Promise<void> {
    const stopPromises: Promise<void>[] = [];
    for (const name of this.processes.keys()) {
      stopPromises.push(this.stopProcess(name, { persist: false }));
    }
    await Promise.allSettled(stopPromises);
  }

  // -- Private helpers --

  private wireProcess(name: string, proc: CloudflaredProcess, runtime: TunnelRuntime): void {
    // Exit handler
    proc.child.once('exit', (code) => {
      this.processes.delete(name);
      this.pids.remove(name);
      runtime.pid = null;
      if (runtime.state !== 'stopped' && !this.stopping.has(name)) {
        if (code !== 0) {
          runtime.lastError = `cloudflared exited with code ${code}`;
        }
        this.setState(name, runtime, code === 0 ? 'disconnected' : 'error');
      }
    });

    // Stderr parser for metrics port, connection state, and log events
    proc.onStderr((line) => {
      const addr = extractMetricsAddr(line);
      if (addr) {
        const port = parseInt(addr.split(':')[1], 10);
        if (!isNaN(port)) runtime.metricsPort = port;
      }

      const parsed = parseLogLine(line);
      if (parsed) {
        const reg = extractRegistration(line);
        const event: ConnectionEvent = {
          timestamp: parsed.timestamp,
          level: parsed.level,
          message: parsed.message,
          ...(reg && {
            connIndex: reg.connIndex,
            connectionId: reg.connectionId,
            location: reg.location,
            edgeIp: reg.edgeIp,
            protocol: reg.protocol,
          }),
        };
        runtime.connections.push(event);
        if (runtime.connections.length > MAX_EVENTS) {
          runtime.connections.shift();
        }
        this.emit('stateChange', { name, state: runtime.state, tunnel: runtime });

        if (reg) {
          this.setState(name, runtime, 'connected');
          runtime.connectedAt = Date.now();
        }
      }
    });
  }

  private setState(name: string, runtime: TunnelRuntime, state: TunnelState): void {
    runtime.state = state;
    this.emit('stateChange', { name, state, tunnel: runtime });
  }

  private persistTunnel(name: string, tunnelConfig: TunnelConfig): void {
    const config = this.store.read() ?? { version: 1 as const, tunnels: {} };
    config.tunnels[name] = tunnelConfig;
    this.store.write(config);
  }

  private persistTunnelState(name: string, lastState: 'running' | 'stopped'): void {
    const config = this.store.read();
    if (!config || !config.tunnels[name]) return;
    config.tunnels[name] = { ...config.tunnels[name], lastState };
    this.store.write(config);
  }

  private removeTunnelFromConfig(name: string): void {
    const config = this.store.read();
    if (!config) return;
    delete config.tunnels[name];
    this.store.write(config);
  }

  private async deleteCloudflareResources(name: string, runtime: TunnelRuntime): Promise<string[]> {
    const warnings = await this.cf.deprovision(
      name,
      { subdomain: runtime.config.subdomain, zone: runtime.config.zone },
      this.token,
      runtime.tunnelId,
    );
    for (const w of warnings) {
      logger.warn(w);
    }
    return warnings;
  }
}
