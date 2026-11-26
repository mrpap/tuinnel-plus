import { describe, test, expect, afterEach } from 'bun:test';
import type { Server } from 'http';
import { createDaemonServer } from '../../src/daemon/server.js';
import { createGuard } from '../../src/daemon/guard.js';
import { SseHub } from '../../src/daemon/sse.js';
import { SessionStore, RateLimiter, hashPassword } from '../../src/daemon/auth.js';
import { memStore, cfgWith } from '../services/helpers.js';
import { FakeBackend, listen, close, raw } from './helpers.js';

let server: Server | null = null;
let hub: SseHub | null = null;
afterEach(async () => {
  hub?.close();
  if (server) await close(server);
  server = null;
  hub = null;
});

const LOCAL = 'l'.repeat(64);
const PASSWORD = 'old-password';

async function boot(opts: { pingMs?: number; now?: () => number } = {}) {
  const store = memStore(cfgWith());
  store.current.web = { passwordHash: hashPassword(PASSWORD) };
  const sessions = new SessionStore(60_000, opts.now);
  hub = new SseHub(new FakeBackend('app'), { pingMs: opts.pingMs, sessionValid: (id) => sessions.valid(id) });
  let port = 0;
  const made = createDaemonServer({
    service: new FakeBackend('app'),
    guard: createGuard({ localToken: LOCAL, sessions, ownHosts: () => [`127.0.0.1:${port}`] }),
    allowedHosts: () => [`127.0.0.1:${port}`],
    isSystemTunnel: () => false,
    hub,
    auth: { store, sessions, limiter: new RateLimiter() },
  });
  server = made.server;
  port = await listen(made.server);
  return { port, sessions };
}

const pair = (res: { headers: Record<string, any> }) => String(([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0];

async function login(port: number): Promise<string> {
  return pair(await raw(port, { method: 'POST', path: '/api/auth/login', body: { password: PASSWORD } }));
}

/** Open /api/events; `closed` resolves true once the server ends the stream. */
async function stream(port: number, headers: Record<string, string>) {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers, signal: ctrl.signal });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const closed = (async () => {
    try {
      for (;;) if ((await reader.read()).done) return true;
    } catch {
      return true;
    }
  })();
  const endedWithin = (ms: number) => Promise.race([closed, new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
  return { endedWithin, abort: () => ctrl.abort() };
}

describe('live updates end with the session', () => {
  test('logout ends that browser\'s stream; a local client stays connected', async () => {
    const { port } = await boot();
    const cookie = await login(port);
    const browser = await stream(port, { cookie });
    const local = await stream(port, { authorization: `Bearer ${LOCAL}` });

    await raw(port, { method: 'POST', path: '/api/auth/logout', headers: { cookie }, body: {} });

    expect(await browser.endedWithin(1000)).toBe(true);
    expect(await local.endedWithin(200)).toBe(false);
    local.abort();
  });

  test('an expired session is dropped on the ping tick', async () => {
    let now = 1_000;
    const { port } = await boot({ pingMs: 20, now: () => now });
    const cookie = await login(port);
    const browser = await stream(port, { cookie });
    expect(await browser.endedWithin(100)).toBe(false);

    now += 61_000;
    expect(await browser.endedWithin(1000)).toBe(true);
  });

  test('changing the password ends other streams; the changer stays signed in and keeps its stream', async () => {
    const { port } = await boot();
    const mine = await login(port);
    const other = await login(port);
    const myStream = await stream(port, { cookie: mine });
    const otherStream = await stream(port, { cookie: other });

    const res = await raw(port, {
      method: 'POST', path: '/api/settings/password', headers: { cookie: mine },
      body: { current: PASSWORD, next: 'brand-new-password' },
    });
    expect(res.status).toBe(200);

    expect(await otherStream.endedWithin(1000)).toBe(true);
    // The changer's stream moves to its new session instead of dropping.
    expect(await myStream.endedWithin(300)).toBe(false);
    myStream.abort();
    const fresh = pair(res);
    const status = await raw(port, { path: '/api/auth/status', headers: { cookie: fresh } });
    expect(status.json.authenticated).toBe(true);
    const again = await stream(port, { cookie: fresh });
    expect(await again.endedWithin(200)).toBe(false);
    again.abort();
  });

  test('a password reload from the CLI ends every browser stream', async () => {
    const { port } = await boot();
    const browser = await stream(port, { cookie: await login(port) });

    const res = await raw(port, { method: 'POST', path: '/api/settings/password/reload', headers: { authorization: `Bearer ${LOCAL}` }, body: {} });
    expect(res.status).toBe(204);

    expect(await browser.endedWithin(1000)).toBe(true);
  });
});
