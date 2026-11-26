import { describe, test, expect, afterEach } from 'bun:test';
import type { Server } from 'http';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonServer } from '../../src/daemon/server.js';
import { FakeBackend, listen, close, raw } from './helpers.js';

let server: Server | null = null;
let assets: string | null = null;
afterEach(async () => {
  if (server) await close(server);
  if (assets) rmSync(assets, { recursive: true, force: true });
  server = null;
  assets = null;
});

async function boot() {
  assets = mkdtempSync(join(tmpdir(), 'tp-assets-'));
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>t</title>');
  let port = 0;
  const made = createDaemonServer({
    service: new FakeBackend('app'),
    guard: () => true,
    allowedHosts: () => [`127.0.0.1:${port}`],
    isSystemTunnel: () => false,
    assetsDir: assets,
  });
  server = made.server;
  port = await listen(made.server);
  return port;
}

describe('response headers', () => {
  test('every response forbids framing and MIME sniffing', async () => {
    const port = await boot();
    const responses = [
      await raw(port, { path: '/api/tunnels' }),
      await raw(port, { path: '/' }),
      await raw(port, { path: '/api/nope' }),
      await raw(port, { path: '/', headers: { host: 'evil.example.com' } }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 404, 421]);
    for (const r of responses) {
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
  });
});
