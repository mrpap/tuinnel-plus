import { EventEmitter } from 'events';
import type { TunnelRuntime } from '../types.js';
import type { CreateOptions } from '../services/tunnel-service.js';
import type { TunnelBackend } from '../services/backend.js';
import type { PurgeResult } from '../services/purge.js';
import { fromWireEvent, fromWireTunnel, type WireEvent, type WireTunnel } from '../daemon/wire.js';
import { SseParser } from './sse-parser.js';

const MAX_EVENTS = 1000;

const logKey = (name: string, timestamp: string, level: string, message: string) =>
  JSON.stringify([name, timestamp, level, message]);

const MAX_RECONNECT_MS = 30_000;

interface Stream {
  ctrl: AbortController;
  openedAt: number;
  /** Events held while the snapshot loads; null once they have been applied. */
  held: Array<{ event: string; data: any }> | null;
  ended: boolean;
}

export interface DaemonClientOptions {
  baseUrl: string;
  localToken: string;
  fetch?: typeof fetch;
  reconnectMs?: number;
  /** Replace the event stream when nothing, not even a ping, arrives for this long. */
  staleMs?: number;
  /** Give up on a snapshot request, or on opening the event stream, after this long, and retry. */
  requestTimeoutMs?: number;
  /** A stream that stayed up this long resets the reconnect backoff. */
  stableMs?: number;
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
  private staleMs: number;
  private requestTimeoutMs: number;
  private stableMs: number;
  /** Reconnects since a stream last stayed up; each one waits twice as long, up to MAX_RECONNECT_MS. */
  private failures = 0;
  private closed = false;
  /** The event stream in use; any earlier one is aborted and its events ignored. */
  private stream: Stream | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: DaemonClientOptions) {
    super();
    this.fetchImpl = opts.fetch ?? fetch;
    this.reconnectMs = opts.reconnectMs ?? 1000;
    // The service pings every 25 s; two missed pings means the stream is dead.
    this.staleMs = opts.staleMs ?? 60_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.stableMs = opts.stableMs ?? 10_000;
  }

  // -- Connection --

  async connect(): Promise<void> {
    await this.sync(false);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stream?.ctrl.abort();
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

  status(): Promise<{ version: string; commit: string | null; uptimeMs: number; counts: Record<string, number>; selfExpose: { enabled: boolean; url: string | null } }> {
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

  private async request<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(this.opts.baseUrl + path, {
      method,
      signal,
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
    const timeout = () => AbortSignal.timeout(this.requestTimeoutMs);
    const list = await this.request<WireTunnel[]>('GET', '/api/tunnels', undefined, timeout());
    const logs = await Promise.all(list.map((t) =>
      this.request<WireEvent[]>('GET', `${this.path(t.name)}/logs?limit=${MAX_EVENTS}`, undefined, timeout()).catch(() => null)));

    if (this.closed) return;

    const next = new Map<string, TunnelRuntime>();
    // A history that failed to load keeps the lines already shown rather than emptying them.
    list.forEach((w, i) => next.set(w.name, fromWireTunnel(w, logs[i]?.map(fromWireEvent) ?? this.cache.get(w.name)?.connections ?? [])));

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

  /**
   * Open the event stream before loading the snapshot, so no change falls between the two.
   * Events that arrive meanwhile are held and applied after the snapshot, which may be older.
   */
  private async sync(diff: boolean): Promise<void> {
    if (this.closed) return;
    this.stream?.ctrl.abort();
    const stream: Stream = { ctrl: new AbortController(), openedAt: Date.now(), held: [], ended: false };
    this.stream = stream;
    try {
      await this.openStream(stream);
      await this.snapshot(diff);
    } catch (err) {
      stream.ctrl.abort();
      if (this.stream === stream) this.stream = null;
      if (this.closed) return; // closed meanwhile: nothing went wrong
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`The background service did not answer within ${Math.round(this.requestTimeoutMs / 1000)} s`);
      }
      throw err;
    }
    if (this.closed) {
      stream.ctrl.abort();
      return;
    }
    // Lines in the history just read, so held live copies of them aren't applied twice.
    const inHistory = new Map<string, number>();
    for (const [name, t] of this.cache) {
      for (const e of t.connections) {
        const key = logKey(name, e.timestamp.toISOString(), e.level, e.message);
        inHistory.set(key, (inHistory.get(key) ?? 0) + 1);
      }
    }
    const held = stream.held!;
    stream.held = null;
    for (const { event, data } of held) {
      if (event === 'log') {
        const key = logKey(data.name, data.event.timestamp, data.event.level, data.event.message);
        const n = inHistory.get(key) ?? 0;
        if (n > 0) { inHistory.set(key, n - 1); continue; }
      }
      this.handle(event, data);
    }
    // Dropped while the snapshot loaded: the snapshot is good, but live events need a new stream.
    if (stream.ended) this.scheduleReconnect();
  }

  private async openStream(stream: Stream): Promise<void> {
    // Until the headers arrive the watchdog isn't running yet; this covers that wait.
    const timer = setTimeout(() => stream.ctrl.abort(new DOMException('Timed out', 'TimeoutError')), this.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/api/events`, {
        headers: { authorization: `Bearer ${this.opts.localToken}`, accept: 'text/event-stream' },
        signal: stream.ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !res.body) {
      let message: string | undefined;
      try { message = (JSON.parse(await res.text()) as { error?: string }).error; } catch { /* non-JSON */ }
      throw new Error(message ?? `Could not open the daemon event stream (${res.status})`);
    }
    void this.pump(res.body, stream);
  }

  private async pump(body: ReadableStream<Uint8Array>, stream: Stream): Promise<void> {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    // Pings keep a healthy stream busy; silence for staleMs means the daemon is gone.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => stream.ctrl.abort(), this.staleMs);
    };
    watch();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        watch();
        if (done || this.stream !== stream) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const data = JSON.parse(frame.data);
          if (stream.held) stream.held.push({ event: frame.event, data });
          else this.handle(frame.event, data);
        }
      }
    } catch {
      // aborted or connection dropped
    }
    clearTimeout(watchdog);
    stream.ended = true;
    if (Date.now() - stream.openedAt >= this.stableMs) this.failures = 0;
    // While its sync is still loading the snapshot, that sync notices and reconnects instead.
    if (!this.closed && this.stream === stream && !stream.held) this.scheduleReconnect();
  }

  /** One reconnect loop at a time: a pending retry already covers a second failure. */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectMs * 2 ** this.failures, MAX_RECONNECT_MS);
    this.failures++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closed) return;
      try {
        const found = await this.opts.rediscover?.();
        if (this.closed) return;
        if (found) this.opts = { ...this.opts, ...found };
        await this.sync(true);
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
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
