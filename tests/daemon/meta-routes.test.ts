import { describe, test, expect, afterEach } from 'bun:test';
import type { Server } from 'http';
import { createDaemonServer, type DaemonDeps } from '../../src/daemon/server.js';
import type { TunnelMetrics } from '../../src/types.js';
import { FakeBackend, listen, close, raw } from './helpers.js';

let server: Server | null = null;
afterEach(async () => { if (server) await close(server); server = null; });

const METRICS: TunnelMetrics = {
  totalRequests: 7, requestErrors: 0, concurrentRequests: 0, haConnections: 4, activeStreams: 0,
  responseCodeCounts: { '200': 7 }, connectLatencyMs: { p50: 1, p95: 2, p99: 3 },
  quicRtt: { smoothed: 10, min: 5 }, lastScrapedAt: new Date('2026-10-22T10:00:00Z'),
};

async function boot(backend: FakeBackend, overrides: Partial<DaemonDeps> = {}) {
  let port = 0;
  const made = createDaemonServer({
    service: backend,
    guard: () => true,
    allowedHosts: () => [`127.0.0.1:${port}`],
    isSystemTunnel: () => false,
    zones: async () => [{ id: 'z1', name: 'example.com' }],
    purge: {
      preview: async () => ({ orphaned: [{ id: 'id-x', name: 'tuinnel-x', status: 'inactive' }], stalePids: [], active: [] }),
      run: async (ids) => ({ deleted: ids.map((id) => `deleted-${id}`), failed: [], cleanedPids: 0 }),
    },
    reload: async () => {},
    scrape: async () => METRICS,
    statusInfo: () => ({ version: '0.1.0', startedAt: Date.now() - 1000, selfExpose: { enabled: false, url: null } }),
    ...overrides,
  });
  server = made.server;
  port = await listen(made.server);
  return port;
}

function withEvents(backend: FakeBackend, name: string, n: number) {
  const t = backend.tunnels.get(name)!;
  for (let i = 0; i < n; i++) {
    t.connections.push({ timestamp: new Date(1_700_000_000_000 + i), level: 'INF', message: `line ${i}` });
  }
}

describe('meta routes', () => {
  test('health is public', async () => {
    const port = await boot(new FakeBackend(), { guard: () => false });
    const res = await raw(port, { path: '/api/health' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, pid: process.pid });
  });

  test('status reports version, uptime, counts, self-expose', async () => {
    const backend = new FakeBackend('a', 'b', 'c');
    backend.tunnels.get('a')!.state = 'connected';
    backend.tunnels.get('b')!.state = 'error';
    const port = await boot(backend);
    const res = await raw(port, { path: '/api/status' });
    expect(res.json.version).toBe('0.1.0');
    expect(res.json.uptimeMs).toBeGreaterThanOrEqual(1000);
    expect(res.json.counts).toEqual({ total: 3, running: 1, error: 1 });
    expect(res.json.selfExpose).toEqual({ enabled: false, url: null });
  });

  test('zones lists zones', async () => {
    const port = await boot(new FakeBackend());
    expect((await raw(port, { path: '/api/zones' })).json).toEqual([{ id: 'z1', name: 'example.com' }]);
  });

  test('logs respects limit', async () => {
    const backend = new FakeBackend('app');
    withEvents(backend, 'app', 5);
    const port = await boot(backend);
    const res = await raw(port, { path: '/api/tunnels/app/logs?limit=2' });
    expect(res.json.map((e: any) => e.message)).toEqual(['line 3', 'line 4']);
    expect(typeof res.json[0].timestamp).toBe('string');
  });

  test('logs defaults to the last 200', async () => {
    const backend = new FakeBackend('app');
    withEvents(backend, 'app', 250);
    const port = await boot(backend);
    const res = await raw(port, { path: '/api/tunnels/app/logs' });
    expect(res.json.length).toBe(200);
    expect(res.json[0].message).toBe('line 50');
  });

  test('logs for unknown tunnel → 404', async () => {
    const port = await boot(new FakeBackend());
    expect((await raw(port, { path: '/api/tunnels/nope/logs' })).status).toBe(404);
  });

  test('metrics 204 when no metricsPort', async () => {
    const port = await boot(new FakeBackend('app'));
    expect((await raw(port, { path: '/api/tunnels/app/metrics' })).status).toBe(204);
  });

  test('metrics proxies scrape', async () => {
    const backend = new FakeBackend('app');
    backend.tunnels.get('app')!.metricsPort = 41234;
    let scraped = '';
    const port = await boot(backend, { scrape: async (addr) => { scraped = addr; return METRICS; } });
    const res = await raw(port, { path: '/api/tunnels/app/metrics' });
    expect(res.status).toBe(200);
    expect(scraped).toBe('127.0.0.1:41234');
    expect(res.json.totalRequests).toBe(7);
    expect(res.json.lastScrapedAt).toBe('2026-10-22T10:00:00.000Z');
  });

  test('metrics scrape failure → 502', async () => {
    const backend = new FakeBackend('app');
    backend.tunnels.get('app')!.metricsPort = 41234;
    const port = await boot(backend, { scrape: async () => { throw new Error('ECONNREFUSED'); } });
    const res = await raw(port, { path: '/api/tunnels/app/metrics' });
    expect(res.status).toBe(502);
    expect(res.json.error).toContain('ECONNREFUSED');
  });

  test('GET purge previews what would be deleted', async () => {
    const port = await boot(new FakeBackend());
    const res = await raw(port, { path: '/api/purge' });
    expect(res.status).toBe(200);
    expect(res.json.orphaned).toEqual([{ id: 'id-x', name: 'tuinnel-x', status: 'inactive' }]);
  });

  test('POST purge deletes only the confirmed ids', async () => {
    const port = await boot(new FakeBackend());
    const res = await raw(port, { method: 'POST', path: '/api/purge', body: { ids: ['id-x'] } });
    expect(res.json).toEqual({ deleted: ['deleted-id-x'], failed: [], cleanedPids: 0 });
  });

  test('POST purge without a list of ids is refused', async () => {
    const port = await boot(new FakeBackend());
    expect((await raw(port, { method: 'POST', path: '/api/purge', body: {} })).status).toBe(400);
    expect((await raw(port, { method: 'POST', path: '/api/purge', body: { ids: [1] } })).status).toBe(400);
  });

  test('reload calls the reload dep', async () => {
    let reloaded = 0;
    const port = await boot(new FakeBackend(), { reload: async () => { reloaded++; } });
    const res = await raw(port, { method: 'POST', path: '/api/reload' });
    expect(res.status).toBe(204);
    expect(reloaded).toBe(1);
  });
});
