import type { ConfigStore } from '../config/store.js';
import type { TunnelBackend } from '../services/backend.js';
import { PartialDeleteError } from '../services/tunnel-service.js';
import { HttpError } from './server.js';

export interface SelfExposeStatus {
  enabled: boolean;
  subdomain: string | null;
  zone: string | null;
  url: string | null;
}

/**
 * Opt-in: run a tunnel that points at the daemon's own port, so the admin UI
 * is reachable at https://<subdomain>.<zone> behind the app password.
 */
export class SelfExpose {
  constructor(
    private service: TunnelBackend,
    private store: ConfigStore,
    private daemonPort: number,
  ) {}

  private settings() {
    return this.store.read()?.web?.selfExpose ?? null;
  }

  private hasPassword(): boolean {
    return !!this.store.read()?.web?.passwordHash;
  }

  status(): SelfExposeStatus {
    const s = this.settings();
    return {
      enabled: !!s?.enabled,
      subdomain: s?.subdomain ?? null,
      zone: s?.zone ?? null,
      url: s?.enabled ? `https://${s.subdomain}.${s.zone}` : null,
    };
  }

  isSystemTunnel(name: string): boolean {
    const s = this.settings();
    return !!s?.enabled && s.subdomain === name;
  }

  async enable(subdomain: string, zone: string): Promise<void> {
    if (!this.hasPassword()) throw new HttpError(409, 'Set a password before exposing the admin UI.');

    const current = this.settings();
    const same = current?.enabled && current.subdomain === subdomain && current.zone === zone;
    if (same) return this.ensure();

    if (this.service.get(subdomain) && !this.isSystemTunnel(subdomain)) {
      throw new HttpError(409, `Tunnel "${subdomain}" already exists — pick another subdomain for the admin UI.`);
    }

    if (current?.enabled) await this.removeTunnel(current.subdomain);

    // Persist first so the tunnel's very first events already carry system=true.
    this.persist({ enabled: true, subdomain, zone });
    let created = false;
    try {
      await this.service.create({ port: this.daemonPort, subdomain, zone, protocol: 'http' });
      created = true;
      await this.service.start(subdomain);
    } catch (err) {
      this.persist(undefined);
      if (created) await this.removeTunnel(subdomain).catch(() => {});
      throw err;
    }
  }

  async disable(): Promise<void> {
    const current = this.settings();
    if (!current) return;
    if (current.enabled) await this.removeTunnel(current.subdomain);
    this.persist({ ...current, enabled: false });
  }

  /** On startup: make sure a configured system tunnel exists and runs. */
  async ensure(): Promise<void> {
    const s = this.settings();
    if (!s?.enabled || !this.hasPassword()) return;
    const existing = this.service.get(s.subdomain);
    if (!existing) {
      await this.service.create({ port: this.daemonPort, subdomain: s.subdomain, zone: s.zone, protocol: 'http' });
      await this.service.start(s.subdomain);
      return;
    }
    // The daemon may now listen on another port (web.port, --port); follow it.
    if (existing.config.port !== this.daemonPort) {
      await this.service.update(s.subdomain, { port: this.daemonPort });
    }
    const t = this.service.get(s.subdomain)!;
    if (t.state === 'stopped' || t.state === 'error' || t.state === 'disconnected') {
      await this.service.start(s.subdomain);
    }
  }

  private async removeTunnel(name: string): Promise<void> {
    if (!this.service.get(name)) return;
    try {
      await this.service.delete(name);
    } catch (err) {
      if (!(err instanceof PartialDeleteError)) throw err;
    }
  }

  private persist(selfExpose: { enabled: boolean; subdomain: string; zone: string } | undefined): void {
    const config = this.store.read() ?? { version: 1 as const, tunnels: {} };
    config.web = { ...config.web, selfExpose };
    if (!selfExpose) delete config.web.selfExpose;
    this.store.write(config);
  }
}
