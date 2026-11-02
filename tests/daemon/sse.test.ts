import { describe, test, expect, afterEach } from 'bun:test';
import type { Server } from 'http';
import { createDaemonServer } from '../../src/daemon/server.js';
import { SseHub } from '../../src/daemon/sse.js';
import { FakeBackend, listen, close } from './helpers.js';

let server: Server | null = null;
let hub: SseHub | null = null;
afterEach(async () => {
  hub?.close();
  if (server) await close(server);
  server = null;
  hub = null;
});

async function boot(backend: FakeBackend, pingMs?: number) {
  hub = new SseHub(backend, { pingMs });
  let port = 0;
  const made = createDaemonServer({
    service: backend,
    guard: () => true,
    allowedHosts: () => [`127.0.0.1:${port}`],
    isSystemTunnel: () => false,
    hub,
  });
  server = made.server;
  port = await listen(made.server);
  return port;
}

async function openStream(port: number) {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // One read stays pending across attempts: abandoning a read that loses the
  // race would silently swallow the chunk it later receives.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const readUntil = async (pred: (s: string) => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pred(buffer)) {
      if (Date.now() > deadline) throw new Error(`timed out; got: ${buffer}`);
      pending ??= reader.read();
      const chunk = await Promise.race([
        pending,
        new Promise<null>((r) => setTimeout(() => r(null), 50)),
      ]);
      if (chunk === null) continue;
      pending = null;
      if (chunk.value) buffer += decoder.decode(chunk.value);
    }
    return buffer;
  };
  return { res, ctrl, readUntil, get buffer() { return buffer; } };
}

function frames(text: string) {
  return text.split('\n\n').filter((f) => f.startsWith('event:')).map((f) => {
    const [ev, data] = f.split('\n');
    return { event: ev.slice('event: '.length), data: JSON.parse(data.slice('data: '.length)) };
  });
}

describe('SseHub', () => {
  test('sends event-stream headers and an initial comment', async () => {
    const port = await boot(new FakeBackend());
    const s = await openStream(port);
    expect(s.res.headers.get('content-type')).toBe('text/event-stream');
    expect(s.res.headers.get('cache-control')).toBe('no-cache');
    await s.readUntil((b) => b.includes(': connected'));
    s.ctrl.abort();
  });

  test('stateChange with a new log line emits tunnel then log', async () => {
    const backend = new FakeBackend('app');
    const port = await boot(backend);
    const s = await openStream(port);
    await s.readUntil((b) => b.includes(': connected'));
    const t = backend.tunnels.get('app')!;
    t.connections.push({ timestamp: new Date('2026-10-22T10:00:00Z'), level: 'INF', message: 'hello' });
    backend.emit('stateChange', { name: 'app', state: t.state, tunnel: t });
    await s.readUntil((b) => b.includes('event: log'));
    const fs = frames(s.buffer);
    expect(fs.map((f) => f.event)).toEqual(['tunnel', 'log']);
    expect(fs[0].data.tunnel.connectorToken).toBeUndefined();
    expect(fs[1].data).toEqual({ name: 'app', event: { timestamp: '2026-10-22T10:00:00.000Z', level: 'INF', message: 'hello' } });
    s.ctrl.abort();
  });

  test('stateChange without a new log line emits only tunnel', async () => {
    const backend = new FakeBackend('app');
    const port = await boot(backend);
    const s = await openStream(port);
    await s.readUntil((b) => b.includes(': connected'));
    const t = backend.tunnels.get('app')!;
    t.connections.push({ timestamp: new Date(), level: 'INF', message: 'once' });
    backend.emit('stateChange', { name: 'app', state: t.state, tunnel: t });
    backend.emit('stateChange', { name: 'app', state: 'connected', tunnel: t });
    await s.readUntil((b) => frames(b).length >= 3);
    expect(frames(s.buffer).map((f) => f.event)).toEqual(['tunnel', 'log', 'tunnel']);
    s.ctrl.abort();
  });

  test('tunnelAdded and tunnelRemoved emit added and removed', async () => {
    const backend = new FakeBackend('app');
    const port = await boot(backend);
    const s = await openStream(port);
    await s.readUntil((b) => b.includes(': connected'));
    backend.emit('tunnelAdded', { name: 'app', tunnel: backend.tunnels.get('app') });
    backend.emit('tunnelRemoved', { name: 'app' });
    await s.readUntil((b) => b.includes('event: removed'));
    const fs = frames(s.buffer);
    expect(fs.map((f) => f.event)).toEqual(['added', 'removed']);
    expect(fs[1].data).toEqual({ name: 'app' });
    s.ctrl.abort();
  });

  test('listeners are detached after client disconnect and close', async () => {
    const backend = new FakeBackend('app');
    const baseline = backend.listenerCount('stateChange');
    const port = await boot(backend);
    const s = await openStream(port);
    await s.readUntil((b) => b.includes(': connected'));
    expect(hub!.clientCount).toBe(1);
    s.ctrl.abort();
    const deadline = Date.now() + 1000;
    while (hub!.clientCount > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(hub!.clientCount).toBe(0);
    hub!.close();
    expect(backend.listenerCount('stateChange')).toBe(baseline);
  });

  test('ping comment sent', async () => {
    const port = await boot(new FakeBackend(), 20);
    const s = await openStream(port);
    await s.readUntil((b) => b.includes(': ping'));
    s.ctrl.abort();
  });
});
