import { describe, test, expect, afterEach } from 'bun:test';
import type { Server } from 'http';
import { createDaemonServer } from '../../src/daemon/server.js';
import { SseHub } from '../../src/daemon/sse.js';
import { createGuard } from '../../src/daemon/guard.js';
import { SessionStore } from '../../src/daemon/auth.js';
import { DaemonClient } from '../../src/client/daemon-client.js';
import { PartialDeleteError } from '../../src/services/tunnel-service.js';
import { FakeBackend, close } from '../daemon/helpers.js';

const TOKEN = 't'.repeat(64);
let running: { server: Server; hub: SseHub } | null = null;
let client: DaemonClient | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  if (running) { running.hub.close(); await close(running.server); }
  running = null;
});

async function serve(backend: FakeBackend, port = 0, token = TOKEN) {
  const hub = new SseHub(backend, { pingMs: 60_000 });
  let actual = port;
  const { server } = createDaemonServer({
    service: backend,
    guard: createGuard({ localToken: token, sessions: new SessionStore() }),
    allowedHosts: () => [`127.0.0.1:${actual}`],
    isSystemTunnel: () => false,
    hub,
    zones: async () => [{ id: 'z1', name: 'example.com' }],
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  actual = (server.address() as { port: number }).port;
  running = { server, hub };
  return actual;
}

async function connect(port: number, reconnectMs = 1000) {
  client = new DaemonClient({ baseUrl: `http://127.0.0.1:${port}`, localToken: TOKEN, reconnectMs });
  await client.connect();
  return client;
}

const until = async (pred: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};


/**
 * A fetch whose event streams the test can cut (as if the daemon dropped them), and whose
 * GET /api/tunnels can run a hook first: to change things, close the client or fail it.
 */
function controlledFetch() {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let onTunnels: (() => Promise<void> | void) | null = null;
  const impl = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith('/api/tunnels') && (init?.method ?? 'GET') === 'GET' && onTunnels) {
      const hook = onTunnels;
      onTunnels = null;
      await hook();
    }
    const res = await fetch(input, init);
    if (!url.endsWith('/api/events') || !res.body) return res;
    const reader = res.body.getReader();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) { ctrl = c; streams.add(c); },
      async pull(c) {
        try {
          const { done, value } = await reader.read();
          if (done) { streams.delete(c); c.close(); } else c.enqueue(value);
        } catch { streams.delete(c); try { c.close(); } catch { /* already closed */ } }
      },
      cancel() { streams.delete(ctrl); return reader.cancel(); },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  return {
    fetch: impl,
    /** End every event stream the client has open, like a daemon going away. */
    cutStreams() { for (const c of streams) { try { c.close(); } catch { /* closed */ } } streams.clear(); },
    /** Run `fn` before the next GET /api/tunnels goes out. */
    beforeNextList(fn: () => Promise<void> | void) { onTunnels = fn; },
  };
}

function log(backend: FakeBackend, name: string, message: string) {
  const t = backend.tunnels.get(name)!;
  t.connections.push({ timestamp: new Date(), level: 'INF', message });
  backend.emit('stateChange', { name, state: t.state, tunnel: t });
}

describe('DaemonClient', () => {
  test('connect fills getAll with logs as Dates', async () => {
    const backend = new FakeBackend('app', 'web');
    backend.tunnels.get('app')!.connections.push({ timestamp: new Date('2026-10-22T10:00:00Z'), level: 'INF', message: 'hi' });
    const c = await connect(await serve(backend));
    expect([...c.getAll().keys()].sort()).toEqual(['app', 'web']);
    const app = c.get('app')!;
    expect(app.connectorToken).toBeNull();
    expect(app.connections[0].timestamp).toBeInstanceOf(Date);
    expect(app.connections[0].message).toBe('hi');
  });

  test('backend stateChange reaches client stateChange', async () => {
    const backend = new FakeBackend('app');
    const c = await connect(await serve(backend));
    const seen: string[] = [];
    c.on('stateChange', ({ name, state }) => seen.push(`${name}:${state}`));
    const t = backend.tunnels.get('app')!;
    t.state = 'connected';
    backend.emit('stateChange', { name: 'app', state: 'connected', tunnel: t });
    await until(() => seen.length > 0);
    expect(seen).toEqual(['app:connected']);
    expect(c.get('app')!.state).toBe('connected');
  });

  test('log event appends to connections', async () => {
    const backend = new FakeBackend('app');
    const c = await connect(await serve(backend));
    const t = backend.tunnels.get('app')!;
    t.connections.push({ timestamp: new Date(), level: 'WRN', message: 'slow' });
    backend.emit('stateChange', { name: 'app', state: t.state, tunnel: t });
    await until(() => c.get('app')!.connections.length === 1);
    expect(c.get('app')!.connections[0].message).toBe('slow');
  });

  test('added and removed events update the cache', async () => {
    const backend = new FakeBackend();
    const c = await connect(await serve(backend));
    const events: string[] = [];
    c.on('tunnelAdded', ({ name }) => events.push(`+${name}`));
    c.on('tunnelRemoved', ({ name }) => events.push(`-${name}`));
    await backend.create({ port: 1, subdomain: 'new', zone: 'example.com' });
    await until(() => c.get('new') !== undefined);
    await backend.delete('new');
    await until(() => c.get('new') === undefined);
    expect(events).toEqual(['+new', '-new']);
  });

  test('create/start/delete call through and errors surface server message', async () => {
    const backend = new FakeBackend('busy');
    const c = await connect(await serve(backend));
    expect(await c.create({ port: 3000, subdomain: 'app', zone: 'example.com' })).toBe('app');
    await c.start('app');
    expect(backend.calls).toEqual(['create', 'start']);
    await expect(c.start('app')).rejects.toThrow('Tunnel "app" is already running');
    await expect(c.stop('nope')).rejects.toThrow('Tunnel "nope" not found');
    backend.failWith.delete = new PartialDeleteError('busy', ['DNS x']);
    await expect(c.delete('busy')).rejects.toThrow('DNS x');
    expect(c.get('busy')).toBeUndefined();
    expect(await c.zones()).toEqual([{ id: 'z1', name: 'example.com' }]);
  });

  test('sends bearer localToken', async () => {
    const port = await serve(new FakeBackend());
    const bad = new DaemonClient({ baseUrl: `http://127.0.0.1:${port}`, localToken: 'wrong' });
    await expect(bad.connect()).rejects.toThrow('Unauthorized');
    bad.close();
  });

  test('reconnect after server restart resyncs', async () => {
    const backend = new FakeBackend('keep', 'gone');
    const port = await serve(backend);
    const c = await connect(port, 20);
    const events: string[] = [];
    c.on('tunnelAdded', ({ name }) => events.push(`+${name}`));
    c.on('tunnelRemoved', ({ name }) => events.push(`-${name}`));
    c.on('stateChange', ({ name, state }) => events.push(`~${name}:${state}`));

    running!.hub.close();
    await close(running!.server);
    running = null;

    backend.tunnels.delete('gone');
    backend.tunnels.get('keep')!.state = 'connected';
    await backend.create({ port: 2, subdomain: 'fresh', zone: 'example.com' });

    await serve(backend, port);
    await until(() => c.get('fresh') !== undefined && c.get('gone') === undefined);
    expect(events.sort()).toEqual(['+fresh', '-gone', '~keep:connected']);

    // the stream is live again
    const k = backend.tunnels.get('keep')!;
    k.state = 'restarting';
    backend.emit('stateChange', { name: 'keep', state: 'restarting', tunnel: k });
    await until(() => c.get('keep')!.state === 'restarting');
  });

  /** Restart the daemon on the same port; `meanwhile` changes the backend while it is down. */
  async function restart(backend: FakeBackend, port: number, meanwhile: () => Promise<unknown> = async () => {}) {
    running!.hub.close();
    await close(running!.server);
    running = null;
    await meanwhile();
    await serve(backend, port);
  }

  test('a change while the event stream is reconnecting is not lost', async () => {
    const backend = new FakeBackend('keep');
    const port = await serve(backend);
    let slowStream = false;
    // After the restart, the event stream takes a while to open again.
    const slow: typeof fetch = (async (input: any, init?: any) => {
      if (slowStream && String(input).endsWith('/api/events')) await new Promise((r) => setTimeout(r, 150));
      return fetch(input, init);
    }) as typeof fetch;
    client = new DaemonClient({ baseUrl: `http://127.0.0.1:${port}`, localToken: TOKEN, reconnectMs: 20, fetch: slow });
    await client.connect();
    const c = client;

    slowStream = true;
    await restart(backend, port, () => backend.create({ port: 2, subdomain: 'fresh', zone: 'example.com' }));
    await until(() => c.get('fresh') !== undefined);

    const k = backend.tunnels.get('keep')!;
    k.state = 'restarting';
    backend.emit('stateChange', { name: 'keep', state: 'restarting', tunnel: k });
    await until(() => c.get('keep')!.state === 'restarting', 1000);
  });

  test('a change that arrives while the tunnel list loads is not overwritten by the older list', async () => {
    const backend = new FakeBackend('keep');
    const port = await serve(backend);
    let racing = false;
    // After the restart, the tunnel list is read, then the tunnel changes before the list arrives.
    const slow: typeof fetch = (async (input: any, init?: any) => {
      const res = await fetch(input, init);
      if (racing && String(input).endsWith('/api/tunnels')) {
        racing = false;
        const k = backend.tunnels.get('keep')!;
        k.state = 'restarting';
        backend.emit('stateChange', { name: 'keep', state: 'restarting', tunnel: k });
        await new Promise((r) => setTimeout(r, 100));
      }
      return res;
    }) as typeof fetch;
    client = new DaemonClient({ baseUrl: `http://127.0.0.1:${port}`, localToken: TOKEN, reconnectMs: 20, fetch: slow });
    await client.connect();
    const c = client;

    racing = true;
    await restart(backend, port);
    await until(() => !racing);
    await until(() => c.get('keep')!.state === 'restarting', 1000);
  });


  test('a stream that drops while the list is reloading leaves one stream and no doubled events', async () => {
    const backend = new FakeBackend('keep');
    const port = await serve(backend);
    const f = controlledFetch();
    client = new DaemonClient({ baseUrl: `http://127.0.0.1:${port}`, localToken: TOKEN, reconnectMs: 20, fetch: f.fetch });
    await client.connect();
    const c = client;

    // The reconnect's own stream drops too, and its list request fails.
    f.beforeNextList(async () => {
      f.cutStreams();
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('daemon went away');
    });
    f.cutStreams();
    await until(() => running!.hub.clientCount === 1);
    await new Promise((r) => setTimeout(r, 200)); // let any second reconnect loop show itself
    expect(running!.hub.clientCount).toBe(1);

    log(backend, 'keep', 'once');
    await until(() => c.get('keep')!.connections.some((e) => e.message === 'once'));
    await new Promise((r) => setTimeout(r, 100));
    expect(c.get('keep')!.connections.filter((e) => e.message === 'once')).toHaveLength(1);
  });

  test('a log line printed while the list reloads shows up once', async () => {
    const backend = new FakeBackend('keep');
    const port = await serve(backend);
    const f = controlledFetch();
    client = new DaemonClient({ baseUrl: `http://127.0.0.1:${port}`, localToken: TOKEN, reconnectMs: 20, fetch: f.fetch });
    await client.connect();
    const c = client;

    // Printed after the new stream is open and before the list and logs are read: it reaches
    // the client both live and in the reloaded history.
    f.beforeNextList(() => log(backend, 'keep', 'during reload'));
    f.cutStreams();
    await until(() => c.get('keep')!.connections.some((e) => e.message === 'during reload'));
    await new Promise((r) => setTimeout(r, 100));
    expect(c.get('keep')!.connections.filter((e) => e.message === 'during reload')).toHaveLength(1);
  });

  test('closing during a reload leaves no stream open and emits nothing more', async () => {
    const backend = new FakeBackend('keep');
    const port = await serve(backend);
    const f = controlledFetch();
    client = new DaemonClient({ baseUrl: `http://127.0.0.1:${port}`, localToken: TOKEN, reconnectMs: 20, fetch: f.fetch });
    await client.connect();
    const c = client;
    let closedAt = 0;
    const after: string[] = [];
    c.on('stateChange', ({ name }) => { if (closedAt) after.push(name); });

    f.beforeNextList(() => { c.close(); closedAt = Date.now(); });
    f.cutStreams();
    await until(() => closedAt > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(running!.hub.clientCount).toBe(0);
    expect(after).toEqual([]);
  });

  test('reconnect follows a restarted daemon with a new token and port', async () => {
    const backend = new FakeBackend('keep');
    let current = { baseUrl: `http://127.0.0.1:${await serve(backend)}`, localToken: TOKEN };
    client = new DaemonClient({ ...current, reconnectMs: 20, rediscover: async () => current });
    await client.connect();
    const c = client;

    running!.hub.close();
    await close(running!.server);
    running = null;

    // A fresh `serve` writes a new random token, possibly on another port.
    const NEW = 'n'.repeat(64);
    backend.tunnels.get('keep')!.state = 'connected';
    current = { baseUrl: `http://127.0.0.1:${await serve(backend, 0, NEW)}`, localToken: NEW };

    await until(() => c.get('keep')!.state === 'connected');
    await c.start('keep').catch(() => {}); // authorised against the new daemon
    expect(backend.calls).toContain('start');
  });
});
