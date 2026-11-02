import { EventEmitter } from 'events';
import { request } from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { TunnelRuntime } from '../../src/types.js';
import type { CreateOptions } from '../../src/services/tunnel-service.js';

export function makeRuntime(name: string, overrides: Partial<TunnelRuntime> = {}): TunnelRuntime {
  return {
    name,
    config: { port: 3000, subdomain: name, zone: 'example.com', protocol: 'http', lastState: 'stopped' },
    state: 'stopped',
    pid: null,
    tunnelId: 'tid-' + name,
    publicUrl: `https://${name}.example.com`,
    connectorToken: 'secret-token',
    metricsPort: null,
    connectedAt: 0,
    lastError: null,
    connections: [],
    ...overrides,
  };
}

/** In-memory TunnelBackend that records every call. */
export class FakeBackend extends EventEmitter {
  tunnels = new Map<string, TunnelRuntime>();
  calls: string[] = [];
  failWith: Partial<Record<string, Error>> = {};

  constructor(...names: string[]) {
    super();
    for (const n of names) this.tunnels.set(n, makeRuntime(n));
  }

  private maybeFail(op: string) {
    this.calls.push(op);
    const err = this.failWith[op];
    if (err) throw err;
  }

  private need(name: string): TunnelRuntime {
    const t = this.tunnels.get(name);
    if (!t) throw new Error(`Tunnel "${name}" not found`);
    return t;
  }

  getAll() { return new Map(this.tunnels); }
  get(name: string) { return this.tunnels.get(name); }

  async create(opts: CreateOptions) {
    this.maybeFail('create');
    if (this.tunnels.has(opts.subdomain)) throw new Error(`Tunnel "${opts.subdomain}" already exists`);
    const t = makeRuntime(opts.subdomain, {
      config: { port: opts.port, subdomain: opts.subdomain, zone: opts.zone, protocol: opts.protocol ?? 'http' },
    });
    this.tunnels.set(opts.subdomain, t);
    this.emit('tunnelAdded', { name: t.name, tunnel: t });
    return t.name;
  }

  async update(name: string, changes: Partial<CreateOptions>) {
    this.maybeFail('update');
    const t = this.need(name);
    t.config = { ...t.config, ...changes };
    if (changes.subdomain && changes.subdomain !== name) {
      this.tunnels.delete(name);
      t.name = changes.subdomain;
      this.tunnels.set(t.name, t);
    }
  }

  async delete(name: string) {
    this.need(name);
    this.tunnels.delete(name);
    this.emit('tunnelRemoved', { name });
    this.maybeFail('delete');
  }

  async start(name: string) {
    this.maybeFail('start');
    const t = this.need(name);
    if (t.state === 'connected') throw new Error(`Tunnel "${name}" is already running`);
    t.state = 'connected';
  }

  async stop(name: string) {
    this.maybeFail('stop');
    this.need(name).state = 'stopped';
  }

  async restart(name: string) {
    this.maybeFail('restart');
    this.need(name).state = 'connected';
  }
}

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any;
}

/** Plain node:http request — gives full control over Host and other headers. */
export function raw(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined
      ? undefined
      : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...opts.headers };
    if (payload !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    const req = request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json: any = undefined;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
