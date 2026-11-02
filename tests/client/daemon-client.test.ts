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
