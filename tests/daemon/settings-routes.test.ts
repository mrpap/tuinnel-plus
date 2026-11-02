import { describe, test, expect, afterEach } from 'bun:test';
import type { Server } from 'http';
import { createDaemonServer } from '../../src/daemon/server.js';
import { createGuard } from '../../src/daemon/guard.js';
import { SessionStore, RateLimiter, hashPassword, verifyPassword } from '../../src/daemon/auth.js';
import { SelfExpose } from '../../src/daemon/self-expose.js';
import { allowedHostsFor } from '../../src/commands/serve.js';
import { memStore, cfgWith } from '../services/helpers.js';
import { FakeBackend, listen, close, raw } from './helpers.js';

let server: Server | null = null;
afterEach(async () => { if (server) await close(server); server = null; });

const LOCAL = 'l'.repeat(64);
const bearer = { authorization: `Bearer ${LOCAL}` };

async function boot(backend = new FakeBackend()) {
  const store = memStore(cfgWith());
  store.current.web = { passwordHash: hashPassword('old-password') };
  const sessions = new SessionStore();
  const selfExpose = new SelfExpose(backend, store, 8484);
  let port = 0;
  const made = createDaemonServer({
    service: backend,
    guard: createGuard({ localToken: LOCAL, sessions }),
    allowedHosts: () => [`127.0.0.1:${port}`],
    isSystemTunnel: (n) => selfExpose.isSystemTunnel(n),
    auth: { store, sessions, limiter: new RateLimiter() },
    selfExpose,
    listenInfo: () => ({ port: 8484, host: '127.0.0.1' }),
  });
  server = made.server;
  port = await listen(made.server);
  return { port, store, sessions, backend };
}

const cookieOf = (res: { headers: Record<string, any> }) => (([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0];

describe('settings routes', () => {
  test('accent hue defaults to purple and is shown before sign-in', async () => {
    const { port } = await boot();
    expect((await raw(port, { path: '/api/settings', headers: bearer })).json.accentHue).toBe(292);
    expect((await raw(port, { path: '/api/auth/status' })).json.accentHue).toBe(292);
  });

  test('PUT appearance saves the accent hue to config', async () => {
    const { port, store } = await boot();
    const res = await raw(port, { method: 'PUT', path: '/api/settings/appearance', body: { accentHue: 255 }, headers: bearer });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ accentHue: 255 });
    expect(store.current.web?.accentHue).toBe(255);
    expect(store.current.web?.passwordHash).toBeDefined();
    expect((await raw(port, { path: '/api/auth/status' })).json.accentHue).toBe(255);
  });

  test('PUT appearance rejects hues outside 0–359 and needs a session', async () => {
    const { port } = await boot();
    for (const accentHue of [-1, 360, 12.5, 'blue']) {
      expect((await raw(port, { method: 'PUT', path: '/api/settings/appearance', body: { accentHue }, headers: bearer })).status).toBe(400);
    }
    expect((await raw(port, { method: 'PUT', path: '/api/settings/appearance', body: { accentHue: 10 } })).status).toBe(401);
  });

  test('GET /api/settings reports self-expose and listen address', async () => {
    const { port } = await boot();
    const res = await raw(port, { path: '/api/settings', headers: bearer });
    expect(res.json).toEqual({
      selfExpose: { enabled: false, subdomain: null, zone: null, url: null },
      accentHue: 292,
      port: 8484,
      host: '127.0.0.1',
    });
  });

  test('PUT self-expose enables then disables', async () => {
    const { port, backend } = await boot();
    const on = await raw(port, { method: 'PUT', path: '/api/settings/self-expose', headers: bearer, body: { enabled: true, subdomain: 'admin', zone: 'example.com' } });
    expect(on.status).toBe(200);
    expect(on.json.url).toBe('https://admin.example.com');
    expect(backend.tunnels.has('admin')).toBe(true);
    const off = await raw(port, { method: 'PUT', path: '/api/settings/self-expose', headers: bearer, body: { enabled: false } });
    expect(off.json.enabled).toBe(false);
    expect(backend.tunnels.has('admin')).toBe(false);
  });

  test('PUT self-expose enabling without subdomain → 400', async () => {
    const { port } = await boot();
    const res = await raw(port, { method: 'PUT', path: '/api/settings/self-expose', headers: bearer, body: { enabled: true } });
    expect(res.status).toBe(400);
  });

  test('system tunnel stop/delete/edit via tunnel routes → 409', async () => {
    const { port, backend } = await boot();
    await raw(port, { method: 'PUT', path: '/api/settings/self-expose', headers: bearer, body: { enabled: true, subdomain: 'admin', zone: 'example.com' } });
    backend.calls = [];
    expect((await raw(port, { method: 'POST', path: '/api/tunnels/admin/stop', headers: bearer })).status).toBe(409);
    expect((await raw(port, { method: 'DELETE', path: '/api/tunnels/admin', headers: bearer })).status).toBe(409);
    expect((await raw(port, { method: 'PATCH', path: '/api/tunnels/admin', headers: bearer, body: { port: 1 } })).status).toBe(409);
    expect(backend.calls).toEqual([]);
    const list = await raw(port, { path: '/api/tunnels', headers: bearer });
    expect(list.json.find((t: any) => t.name === 'admin').system).toBe(true);
  });

  test('password change revokes other sessions', async () => {
    const { port, store } = await boot();
    const login = async () => cookieOf(await raw(port, { method: 'POST', path: '/api/auth/login', body: { password: 'old-password' } }));
    const mine = await login();
    const other = await login();
    const res = await raw(port, { method: 'POST', path: '/api/settings/password', headers: { cookie: mine }, body: { current: 'old-password', next: 'brand-new-password' } });
    expect(res.status).toBe(200);
    const fresh = cookieOf(res);
    expect(fresh).toMatch(/^tp_session=/);
    expect(verifyPassword('brand-new-password', store.current.web!.passwordHash!)).toBe(true);
    expect((await raw(port, { path: '/api/tunnels', headers: { cookie: other } })).status).toBe(401);
    expect((await raw(port, { path: '/api/tunnels', headers: { cookie: mine } })).status).toBe(401);
    expect((await raw(port, { path: '/api/tunnels', headers: { cookie: fresh } })).status).toBe(200);
  });

  test('password change rejects wrong current and short next', async () => {
    const { port } = await boot();
    const wrong = await raw(port, { method: 'POST', path: '/api/settings/password', headers: bearer, body: { current: 'nope-nope', next: 'brand-new-password' } });
    expect(wrong.status).toBe(403);
    const short = await raw(port, { method: 'POST', path: '/api/settings/password', headers: bearer, body: { current: 'old-password', next: 'short' } });
    expect(short.status).toBe(400);
  });

  test('password reload is bearer-only and revokes sessions', async () => {
    const { port } = await boot();
    const cookie = cookieOf(await raw(port, { method: 'POST', path: '/api/auth/login', body: { password: 'old-password' } }));
    expect((await raw(port, { method: 'POST', path: '/api/settings/password/reload', headers: { cookie }, body: {} })).status).toBe(403);
    expect((await raw(port, { method: 'POST', path: '/api/settings/password/reload', headers: bearer })).status).toBe(204);
    expect((await raw(port, { path: '/api/tunnels', headers: { cookie } })).status).toBe(401);
  });
});

describe('allowedHostsFor', () => {
  test('self-expose host is accepted by host check once enabled', () => {
    const off = allowedHostsFor('127.0.0.1', 8484, { enabled: false, subdomain: null, zone: null, url: null });
    expect(off).toContain('127.0.0.1:8484');
    expect(off).toContain('localhost:8484');
    expect(off).not.toContain('admin.example.com');
    const on = allowedHostsFor('127.0.0.1', 8484, { enabled: true, subdomain: 'admin', zone: 'example.com', url: 'https://admin.example.com' });
    expect(on).toContain('admin.example.com');
  });
});
