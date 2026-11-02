import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Server } from 'http';
import { createDaemonServer } from '../../src/daemon/server.js';
import { resolveAssetsDir } from '../../src/daemon/static.js';
import { FakeBackend, listen, close, raw } from './helpers.js';

let assets: string;
let server: Server | null = null;

beforeAll(() => {
  assets = mkdtempSync(join(tmpdir(), 'tp-assets-'));
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>tp</title>');
  writeFileSync(join(assets, 'app.js'), 'console.log(1)');
  writeFileSync(join(assets, 'styles.css'), 'body{}');
});
afterAll(() => rmSync(assets, { recursive: true, force: true }));
afterEach(async () => { if (server) await close(server); server = null; });

async function boot() {
  let port = 0;
  const made = createDaemonServer({
    service: new FakeBackend(),
    guard: () => false,
    allowedHosts: () => [`127.0.0.1:${port}`],
    isSystemTunnel: () => false,
    assetsDir: assets,
  });
  server = made.server;
  port = await listen(made.server);
  return port;
}

describe('static assets', () => {
  test('GET / serves index.html as text/html', async () => {
    const port = await boot();
    const res = await raw(port, { path: '/' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.text).toContain('<title>tp</title>');
  });

  test('GET /app.js and /styles.css get their content types', async () => {
    const port = await boot();
    expect((await raw(port, { path: '/app.js' })).headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect((await raw(port, { path: '/styles.css' })).headers['content-type']).toBe('text/css; charset=utf-8');
  });

  test('path traversal → 404', async () => {
    const port = await boot();
    expect((await raw(port, { path: '/../package.json' })).status).toBe(404);
    expect((await raw(port, { path: '/%2e%2e/package.json' })).status).toBe(404);
    expect((await raw(port, { path: '/..%2fpackage.json' })).status).toBe(404);
  });

  test('missing file → 404', async () => {
    const port = await boot();
    expect((await raw(port, { path: '/nope.js' })).status).toBe(404);
  });

  test('static is public (guard false) but /api stays guarded', async () => {
    const port = await boot();
    expect((await raw(port, { path: '/app.js' })).status).toBe(200);
    expect((await raw(port, { path: '/api/tunnels' })).status).toBe(401);
  });

  test('the web UI ships an SVG favicon and links it', async () => {
    const real = resolveAssetsDir();
    expect(readFileSync(join(real, 'index.html'), 'utf-8')).toContain('<link rel="icon" href="favicon.svg" type="image/svg+xml">');
    writeFileSync(join(assets, 'favicon.svg'), readFileSync(join(real, 'favicon.svg')));
    const port = await boot();
    const res = await raw(port, { path: '/favicon.svg' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
  });

  test('resolveAssetsDir finds src/web when running from source', () => {
    expect(resolveAssetsDir()).toMatch(/src\/web$/);
  });
});
