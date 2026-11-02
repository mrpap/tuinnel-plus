import { describe, test, expect, afterEach } from 'bun:test';
import { createDaemonServer, errorStatus, type DaemonDeps } from '../../src/daemon/server.js';
import { PartialDeleteError } from '../../src/services/tunnel-service.js';
import { FakeBackend, listen, close, raw } from './helpers.js';
import type { Server } from 'http';

let server: Server | null = null;
afterEach(async () => { if (server) await close(server); server = null; });

async function boot(backend: FakeBackend, overrides: Partial<DaemonDeps> = {}) {
  let port = 0;
  const made = createDaemonServer({
    service: backend,
    guard: () => true,
    allowedHosts: () => [`127.0.0.1:${port}`],
    isSystemTunnel: () => false,
    ...overrides,
  });
  server = made.server;
  port = await listen(made.server);
  return port;
}

describe('tunnel routes', () => {
  test('GET /api/tunnels lists sorted wire tunnels', async () => {
    const port = await boot(new FakeBackend('zeta', 'alpha'));
    const res = await raw(port, { path: '/api/tunnels' });
    expect(res.status).toBe(200);
    expect(res.json.map((t: any) => t.name)).toEqual(['alpha', 'zeta']);
    expect(res.text).not.toContain('secret-token');
  });

  test('GET /api/tunnels/:name returns one tunnel', async () => {
    const port = await boot(new FakeBackend('app'));
    const res = await raw(port, { path: '/api/tunnels/app' });
    expect(res.status).toBe(200);
    expect(res.json.name).toBe('app');
  });

  test('POST /api/tunnels validates body', async () => {
    const port = await boot(new FakeBackend());
    const res = await raw(port, { method: 'POST', path: '/api/tunnels', body: { port: 70000, subdomain: 'a', zone: 'example.com' } });
    expect(res.status).toBe(400);
    expect(typeof res.json.error).toBe('string');
  });

  test('POST /api/tunnels rejects an invalid subdomain', async () => {
    const port = await boot(new FakeBackend());
    const res = await raw(port, { method: 'POST', path: '/api/tunnels', body: { port: 3000, subdomain: '-bad-', zone: 'example.com' } });
    expect(res.status).toBe(400);
  });

  test('POST /api/tunnels with start:true creates then starts', async () => {
    const backend = new FakeBackend();
    const port = await boot(backend);
    const res = await raw(port, { method: 'POST', path: '/api/tunnels', body: { port: 3000, subdomain: 'app', zone: 'example.com', start: true } });
    expect(res.status).toBe(201);
    expect(res.json.name).toBe('app');
    expect(backend.calls).toEqual(['create', 'start']);
  });

  test('PATCH /api/tunnels/:name returns the renamed tunnel', async () => {
    const port = await boot(new FakeBackend('app'));
    const res = await raw(port, { method: 'PATCH', path: '/api/tunnels/app', body: { subdomain: 'web' } });
    expect(res.status).toBe(200);
    expect(res.json.name).toBe('web');
  });

  test('DELETE returns warnings from PartialDeleteError', async () => {
    const backend = new FakeBackend('a');
    backend.failWith.delete = new PartialDeleteError('a', ['DNS x']);
    const port = await boot(backend);
    const res = await raw(port, { method: 'DELETE', path: '/api/tunnels/a' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ removed: true, warnings: ['DNS x'] });
  });

  test('DELETE without problems returns no warnings', async () => {
    const port = await boot(new FakeBackend('a'));
    const res = await raw(port, { method: 'DELETE', path: '/api/tunnels/a' });
    expect(res.json).toEqual({ removed: true, warnings: [] });
  });

  test('unknown tunnel → 404', async () => {
    const port = await boot(new FakeBackend());
    expect((await raw(port, { path: '/api/tunnels/nope' })).status).toBe(404);
    expect((await raw(port, { method: 'POST', path: '/api/tunnels/nope/start' })).status).toBe(404);
  });

  test('start twice → 409', async () => {
    const port = await boot(new FakeBackend('app'));
    expect((await raw(port, { method: 'POST', path: '/api/tunnels/app/start' })).status).toBe(200);
    const second = await raw(port, { method: 'POST', path: '/api/tunnels/app/start' });
    expect(second.status).toBe(409);
    expect(second.json.error).toContain('already running');
  });

  test('unknown route → 404', async () => {
    const port = await boot(new FakeBackend());
    const res = await raw(port, { path: '/api/nope' });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'Not found' });
  });

  test('malformed JSON body → 400', async () => {
    const port = await boot(new FakeBackend());
    const res = await raw(port, { method: 'POST', path: '/api/tunnels', body: '{not json' });
    expect(res.status).toBe(400);
  });

  test('oversized body → 413', async () => {
    const port = await boot(new FakeBackend());
    const res = await raw(port, { method: 'POST', path: '/api/tunnels', body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) });
    expect(res.status).toBe(413);
  });

  test('guard false → 401', async () => {
    const port = await boot(new FakeBackend('app'), { guard: () => false });
    const res = await raw(port, { path: '/api/tunnels' });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: 'Unauthorized' });
  });

  test('foreign Host header → 421', async () => {
    const port = await boot(new FakeBackend());
    const res = await raw(port, { path: '/api/tunnels', headers: { host: 'evil.example:80' } });
    expect(res.status).toBe(421);
  });

  test('system tunnel stop → 409', async () => {
    const backend = new FakeBackend('admin');
    const port = await boot(backend, { isSystemTunnel: (n) => n === 'admin' });
    const stop = await raw(port, { method: 'POST', path: '/api/tunnels/admin/stop' });
    expect(stop.status).toBe(409);
    expect(stop.json.error).toBe('This tunnel serves the admin UI; disable self-expose in Settings instead.');
    expect((await raw(port, { method: 'DELETE', path: '/api/tunnels/admin' })).status).toBe(409);
    expect(backend.calls).toEqual([]);
  });

  test('system tunnels are flagged in listings', async () => {
    const port = await boot(new FakeBackend('admin'), { isSystemTunnel: (n) => n === 'admin' });
    const res = await raw(port, { path: '/api/tunnels' });
    expect(res.json[0].system).toBe(true);
  });
});

describe('errorStatus', () => {
  test('maps tunnel lookups and conflicts, and nothing else by accident', () => {
    expect(errorStatus(new Error('Tunnel "app" not found'))).toBe(404);
    expect(errorStatus(new Error('Tunnel "app" already exists'))).toBe(409);
    expect(errorStatus(new Error('Tunnel "app" is already running'))).toBe(409);
    expect(errorStatus(new Error('cloudflared binary not found'))).toBe(500);
    expect(errorStatus(new Error('Zone "nope.com" not found in your Cloudflare account.'))).toBe(400);
  });
});
