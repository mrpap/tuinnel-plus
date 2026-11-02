import { EventEmitter } from 'events';
import type { TunnelRuntime } from '../types.js';
import type { CreateOptions } from '../services/tunnel-service.js';
import type { TunnelBackend } from '../services/backend.js';
import type { PurgeResult } from '../services/purge.js';
import { fromWireEvent, fromWireTunnel, type WireEvent, type WireTunnel } from '../daemon/wire.js';
import { SseParser } from './sse-parser.js';

const MAX_EVENTS = 1000;

export interface DaemonClientOptions {
  baseUrl: string;
  localToken: string;
  fetch?: typeof fetch;
  reconnectMs?: number;
  /**
   * Where the daemon is now. Each `serve` writes a new token (and may bind
   * another port), so reconnects re-read it rather than reuse the old one.
   */
  rediscover?: () => Promise<{ baseUrl: string; localToken: string } | null>;
}

/**
 * HTTP client for the tuinnel-plus daemon. Mirrors the TunnelService surface —
 * a synchronous getAll() backed by a live cache, and the same stateChange /
 * tunnelAdded / tunnelRemoved events — so the TUI can't tell the difference.
 */
export class DaemonClient extends EventEmitter implements TunnelBackend {
  private cache = new Map<string, TunnelRuntime>();
  private fetchImpl: typeof fetch;
  private reconnectMs: number;
  private closed = false;
  private stream: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: DaemonClientOptions) {
    super();
    this.fetchImpl = opts.fetch ?? fetch;
    this.reconnectMs = opts.reconnectMs ?? 1000;
  }

  // -- Connection --

  async connect(): Promise<void> {
    await this.snapshot(false);
    await this.openStream();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stream?.abort();
    this.stream = null;
  }

  // -- Query (TunnelBackend) --

  getAll(): Map<string, TunnelRuntime> {
    return new Map(this.cache);
  }

  get(name: string): TunnelRuntime | undefined {
    return this.cache.get(name);
  }

  // -- Lifecycle (TunnelBackend) --

  async create(opts: CreateOptions): Promise<string> {
    const t = await this.request<WireTunnel>('POST', '/api/tunnels', opts);
    return t.name;
  }

  async update(name: string, changes: Partial<Pick<CreateOptions, 'port' | 'subdomain' | 'zone' | 'protocol'>>): Promise<void> {
    await this.request('PATCH', this.path(name), changes);
  }

  async delete(name: string): Promise<void> {
    const res = await this.request<{ removed: boolean; warnings: string[] }>('DELETE', this.path(name));
    this.drop(name);
    if (res.warnings.length > 0) {
      throw new Error(`Removed "${name}", but some Cloudflare resources may remain: ${res.warnings.join('; ')}`);
    }
  }

  async start(name: string): Promise<void> {
    await this.request('POST', `${this.path(name)}/start`);
  }

  async stop(name: string): Promise<void> {
    await this.request('POST', `${this.path(name)}/stop`);
  }

  async restart(name: string): Promise<void> {
    await this.request('POST', `${this.path(name)}/restart`);
  }

  // -- Daemon extras --

  zones(): Promise<Array<{ id: string; name: string }>> {
    return this.request('GET', '/api/zones');
  }

  status(): Promise<{ version: string; uptimeMs: number; counts: Record<string, number>; selfExpose: { enabled: boolean; url: string | null } }> {
    return this.request('GET', '/api/status');
  }

  async reload(): Promise<void> {
    await this.request('POST', '/api/reload');
  }

  purge(): Promise<PurgeResult> {
    return this.request('POST', '/api/purge');
  }

  async setSelfExpose(body: { enabled: boolean; subdomain?: string; zone?: string }): Promise<{ enabled: boolean; url: string | null }> {
    return this.request('PUT', '/api/settings/self-expose', body);
  }

  // -- Internals --

  private path(name: string): string {
    return `/api/tunnels/${encodeURIComponent(name)}`;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.opts.baseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.localToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = undefined;
    try { data = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
    if (!res.ok) {
      const message = (data as { error?: string } | undefined)?.error ?? `Daemon request failed (${res.status})`;
      throw new Error(message);
    }
    return data as T;
  }

  /** Load all tunnels + their logs. With `diff`, emit events for what changed since the cache. */
  private async snapshot(diff: boolean): Promise<void> {
    const list = await this.request<WireTunnel[]>('GET', '/api/tunnels');
    const logs = await Promise.all(list.map((t) =>
      this.request<WireEvent[]>('GET', `${this.path(t.name)}/logs?limit=${MAX_EVENTS}`).catch(() => [] as WireEvent[])));

    const next = new Map<string, TunnelRuntime>();
    list.forEach((w, i) => next.set(w.name, fromWireTunnel(w, logs[i].map(fromWireEvent))));

    const previous = this.cache;
    this.cache = next;
    if (!diff) return;

    for (const name of previous.keys()) {
      if (!next.has(name)) this.emit('tunnelRemoved', { name });
    }
    for (const [name, tunnel] of next) {
      if (previous.has(name)) this.emit('stateChange', { name, state: tunnel.state, tunnel });
      else this.emit('tunnelAdded', { name, tunnel });
    }
  }

  private async openStream(): Promise<void> {
    const ctrl = new AbortController();
    this.stream = ctrl;
    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/events`, {
      headers: { authorization: `Bearer ${this.opts.localToken}`, accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Could not open the daemon event stream (${res.status})`);
    void this.pump(res.body, ctrl);
  }

  private async pump(body: ReadableStream<Uint8Array>, ctrl: AbortController): Promise<void> {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          this.handle(frame.event, JSON.parse(frame.data));
        }
      }
    } catch {
      // aborted or connection dropped
    }
    if (!this.closed && this.stream === ctrl) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(async () => {
      if (this.closed) return;
      try {
        const found = await this.opts.rediscover?.();
        if (found) this.opts = { ...this.opts, ...found };
        await this.snapshot(true);
        await this.openStream();
      } catch {
        this.scheduleReconnect();
      }
    }, this.reconnectMs);
  }

  private handle(event: string, data: any): void {
    switch (event) {
      case 'tunnel': {
        const existing = this.cache.get(data.name);
        const tunnel = fromWireTunnel(data.tunnel, existing?.connections ?? []);
        // Like TunnelService: a tunnel still being created emits state but isn't listed yet.
        if (existing) this.cache.set(data.name, tunnel);
        this.emit('stateChange', { name: data.name, state: data.state, tunnel });
        break;
      }
      case 'log': {
        const tunnel = this.cache.get(data.name);
        if (!tunnel) break;
        tunnel.connections.push(fromWireEvent(data.event));
        if (tunnel.connections.length > MAX_EVENTS) tunnel.connections.shift();
        this.emit('stateChange', { name: data.name, state: tunnel.state, tunnel });
        break;
      }
      case 'added': {
        if (this.cache.has(data.name)) break;
        const tunnel = fromWireTunnel(data.tunnel);
        this.cache.set(data.name, tunnel);
        this.emit('tunnelAdded', { name: data.name, tunnel });
        break;
      }
      case 'removed':
        this.drop(data.name);
        break;
    }
  }

  private drop(name: string): void {
    if (this.cache.delete(name)) this.emit('tunnelRemoved', { name });
  }
}
