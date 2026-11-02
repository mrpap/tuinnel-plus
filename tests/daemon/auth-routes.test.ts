import { describe, test, expect, afterEach } from 'bun:test';
import type { Server } from 'http';
import { createDaemonServer } from '../../src/daemon/server.js';
import { createGuard, isLoopbackPeer, clientKey } from '../../src/daemon/guard.js';
import { SessionStore, RateLimiter, hashPassword } from '../../src/daemon/auth.js';
import { memStore, cfgWith } from '../services/helpers.js';
import { FakeBackend, listen, close, raw } from './helpers.js';

let server: Server | null = null;
afterEach(async () => { if (server) await close(server); server = null; });

const LOCAL = 'l'.repeat(64);

async function boot(opts: { password?: string } = {}) {
  const store = memStore(cfgWith());
  if (opts.password) store.current.web = { passwordHash: hashPassword(opts.password) };
  const sessions = new SessionStore();
  let port = 0;
  const made = createDaemonServer({
    service: new FakeBackend('app'),
    guard: createGuard({ localToken: LOCAL, sessions, ownHosts: () => [`127.0.0.1:${port}`, 'admin.example.com'] }),
    allowedHosts: () => [`127.0.0.1:${port}`, 'admin.example.com'],
    isSystemTunnel: () => false,
    auth: { store, sessions, limiter: new RateLimiter() },
  });
  server = made.server;
  port = await listen(made.server);
  return { port, store, sessions };
}

function cookieOf(res: { headers: Record<string, any> }): string {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return set[0] ?? '';
}

const pair = (setCookie: string) => setCookie.split(';')[0];

async function login(port: number, password: string, headers: Record<string, string> = {}) {
  return raw(port, { method: 'POST', path: '/api/auth/login', body: { password }, headers });
}

describe('auth routes', () => {
  test('status reports needsPasswordSetup when no hash', async () => {
    const { port } = await boot();
    const res = await raw(port, { path: '/api/auth/status' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ authenticated: false, needsPasswordSetup: true, accentHue: 292 });
  });

  test('setup over tunnel is refused', async () => {
    const { port, store } = await boot();
    const res = await raw(port, {
      method: 'POST', path: '/api/auth/setup', body: { password: 'long-enough-pw' },
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    expect(res.status).toBe(403);
    expect(store.current.web?.passwordHash).toBeUndefined();
  });

  test('setup rejects short password', async () => {
    const { port } = await boot();
    const res = await raw(port, { method: 'POST', path: '/api/auth/setup', body: { password: 'short' } });
    expect(res.status).toBe(400);
  });

  test('setup is refused once a password exists', async () => {
    const { port } = await boot({ password: 'existing-pw' });
    const res = await raw(port, { method: 'POST', path: '/api/auth/setup', body: { password: 'another-pw' } });
    expect(res.status).toBe(409);
  });

  test('setup stores a hash and issues a session', async () => {
    const { port, store } = await boot();
    const res = await raw(port, { method: 'POST', path: '/api/auth/setup', body: { password: 'long-enough-pw' } });
    expect(res.status).toBe(200);
    expect(store.current.web?.passwordHash).toMatch(/^scrypt\$/);
    const status = await raw(port, { path: '/api/auth/status', headers: { cookie: pair(cookieOf(res)) } });
    expect(status.json).toEqual({ authenticated: true, needsPasswordSetup: false, accentHue: 292 });
  });

  test('login issues HttpOnly SameSite=Lax cookie', async () => {
    const { port } = await boot({ password: 'hunter2hunter2' });
    const res = await login(port, 'hunter2hunter2');
    expect(res.status).toBe(200);
    const c = cookieOf(res);
    expect(c).toMatch(/^tp_session=[0-9a-f]{64}; /);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=604800');
    expect(c).not.toContain('Secure');
  });

  test('cookie Secure when tunneled', async () => {
    const { port } = await boot({ password: 'hunter2hunter2' });
    const res = await login(port, 'hunter2hunter2', { 'cf-connecting-ip': '1.2.3.4' });
    expect(cookieOf(res)).toContain('Secure');
  });

  test('wrong password 401; 6th attempt 429', async () => {
    const { port } = await boot({ password: 'hunter2hunter2' });
    for (let i = 0; i < 5; i++) {
      const res = await login(port, 'nope-nope');
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: 'Invalid password' });
    }
    expect((await login(port, 'hunter2hunter2')).status).toBe(429);
  });

  test('rate limit is per client ip behind the tunnel', async () => {
    const { port } = await boot({ password: 'hunter2hunter2' });
    for (let i = 0; i < 5; i++) await login(port, 'nope-nope', { 'cf-connecting-ip': '9.9.9.9' });
    expect((await login(port, 'nope-nope', { 'cf-connecting-ip': '9.9.9.9' })).status).toBe(429);
    expect((await login(port, 'hunter2hunter2', { 'cf-connecting-ip': '8.8.8.8' })).status).toBe(200);
  });

  test('cookie session reaches /api/tunnels; logout revokes it', async () => {
    const { port } = await boot({ password: 'hunter2hunter2' });
    const cookie = pair(cookieOf(await login(port, 'hunter2hunter2')));
    expect((await raw(port, { path: '/api/tunnels', headers: { cookie } })).status).toBe(200);
    const out = await raw(port, { method: 'POST', path: '/api/auth/logout', body: {}, headers: { cookie } });
    expect(out.status).toBe(200);
    expect(cookieOf(out)).toContain('Max-Age=0');
    expect((await raw(port, { path: '/api/tunnels', headers: { cookie } })).status).toBe(401);
  });

  test('cookie POST without JSON content-type → 401', async () => {
    const { port } = await boot({ password: 'hunter2hunter2' });
    const cookie = pair(cookieOf(await login(port, 'hunter2hunter2')));
    const res = await raw(port, {
      method: 'POST', path: '/api/tunnels/app/start', body: '{}',
      headers: { cookie, 'content-type': 'text/plain' },
    });
    expect(res.status).toBe(401);
  });

  test('mismatched Origin → 401', async () => {
    const { port } = await boot({ password: 'hunter2hunter2' });
    const cookie = pair(cookieOf(await login(port, 'hunter2hunter2')));
    const res = await raw(port, {
      method: 'POST', path: '/api/tunnels/app/start', body: {},
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(401);
    const same = await raw(port, {
      method: 'POST', path: '/api/tunnels/app/start', body: {},
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
    });
    expect(same.status).toBe(200);
  });

  test('bearer localToken bypasses password', async () => {
    const { port } = await boot({ password: 'hunter2hunter2' });
    const res = await raw(port, { method: 'POST', path: '/api/tunnels/app/start', body: '', headers: { authorization: `Bearer ${LOCAL}` } });
    expect(res.status).toBe(200);
  });

  test('wrong bearer token is rejected', async () => {
    const { port } = await boot();
    expect((await raw(port, { path: '/api/tunnels', headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });

  test('loopback request without credentials is NOT trusted', async () => {
    const { port } = await boot();
    expect((await raw(port, { path: '/api/tunnels' })).status).toBe(401);
  });

  test('cross-site text/plain setup is refused (no CORS preflight)', async () => {
    const { port, store } = await boot();
    const res = await raw(port, {
      method: 'POST', path: '/api/auth/setup', body: JSON.stringify({ password: 'attacker-password' }),
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(store.current.web?.passwordHash).toBeUndefined();
  });

  test('setup from a foreign Origin is refused even as JSON', async () => {
    const { port, store } = await boot();
    const res = await raw(port, {
      method: 'POST', path: '/api/auth/setup', body: { password: 'attacker-password' },
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(store.current.web?.passwordHash).toBeUndefined();
  });

  test('cross-site login attempts do not burn the rate limit', async () => {
    const { port } = await boot({ password: 'correct-horse' });
    for (let i = 0; i < 6; i++) {
      const res = await login(port, 'wrong', { origin: 'https://evil.example' });
      expect(res.status).toBe(403);
    }
    expect((await login(port, 'correct-horse')).status).toBe(200);
  });

  test('same-origin JSON setup from the web UI still works', async () => {
    const { port, store } = await boot();
    const res = await raw(port, {
      method: 'POST', path: '/api/auth/setup', body: { password: 'long-enough-pw' },
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);
    expect(store.current.web?.passwordHash).toBeDefined();
  });

  test('clientKey trusts cf-connecting-ip only from the local cloudflared', () => {
    const req = (remoteAddress: string, ip?: string) =>
      ({ socket: { remoteAddress }, headers: ip ? { 'cf-connecting-ip': ip } : {} }) as any;
    expect(clientKey(req('127.0.0.1', '9.9.9.9'))).toBe('9.9.9.9');
    expect(clientKey(req('192.168.1.20', '9.9.9.9'))).toBe('192.168.1.20');
    expect(clientKey(req('192.168.1.20'))).toBe('192.168.1.20');
  });

  // cloudflared hands requests to the daemon as Host 127.0.0.1:<port>, while the
  // browser's Origin is the public https address of the remote web UI.
  const viaTunnel = { 'cf-connecting-ip': '1.2.3.4', origin: 'https://admin.example.com' };

  test('remote sign-in through the tunnel is not mistaken for a cross-site request', async () => {
    const { port } = await boot({ password: 'hunter2hunter2' });
    expect((await login(port, 'nope-nope', viaTunnel)).status).toBe(401);
    expect((await login(port, 'hunter2hunter2', viaTunnel)).status).toBe(200);
  });

  test('a signed-in remote browser can make changes through the tunnel', async () => {
    const { port } = await boot({ password: 'hunter2hunter2' });
    const cookie = pair(cookieOf(await login(port, 'hunter2hunter2', viaTunnel)));
    const res = await raw(port, { method: 'POST', path: '/api/tunnels/app/start', body: {}, headers: { ...viaTunnel, cookie } });
    expect(res.status).toBe(200);
  });

  test('other sites are still refused through the tunnel', async () => {
    const { port } = await boot({ password: 'hunter2hunter2' });
    expect((await login(port, 'hunter2hunter2', { ...viaTunnel, origin: 'https://evil.example' })).status).toBe(403);
  });

  test('isLoopbackPeer only trusts loopback sockets', () => {
    const peer = (remoteAddress: string) => ({ socket: { remoteAddress } }) as any;
    expect(isLoopbackPeer(peer('127.0.0.1'))).toBe(true);
    expect(isLoopbackPeer(peer('::1'))).toBe(true);
    expect(isLoopbackPeer(peer('::ffff:127.0.0.1'))).toBe(true);
    expect(isLoopbackPeer(peer('192.168.1.20'))).toBe(false);
  });
});
