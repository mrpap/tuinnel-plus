import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemon, type RunningDaemon } from '../../src/commands/serve.js';
import { readDescriptor } from '../../src/daemon/descriptor.js';
import { memStore, memPids, cfgWith } from '../services/helpers.js';
import { raw } from './helpers.js';

let dir: string;
let daemon: RunningDaemon | null = null;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tp-serve-')); });
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(dir, { recursive: true, force: true });
});

async function boot() {
  daemon = await startDaemon({
    port: 0,
    stateDir: dir,
    store: memStore(cfgWith()),
    token: '',
    pids: memPids(),
    reclaim: async () => [],
    log: () => {},
  });
  return daemon;
}

describe('serve', () => {
  test('serve writes descriptor and answers health', async () => {
    const d = await boot();
    const desc = readDescriptor(dir)!;
    expect(desc.port).toBe(d.port);
    expect(desc.pid).toBe(process.pid);
    expect(desc.localToken).toMatch(/^[0-9a-f]{64}$/);
    const res = await raw(d.port, { path: '/api/health' });
    expect(res.json.ok).toBe(true);
  });

  test('API requires bearer localToken', async () => {
    const d = await boot();
    expect((await raw(d.port, { path: '/api/tunnels' })).status).toBe(401);
    const ok = await raw(d.port, { path: '/api/tunnels', headers: { authorization: `Bearer ${d.localToken}` } });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual([]);
  });

  test('a second daemon on the same state dir is refused', async () => {
    await boot();
    await expect(startDaemon({
      port: 0, stateDir: dir, store: memStore(cfgWith()), token: '', pids: memPids(), reclaim: async () => [], log: () => {},
    })).rejects.toThrow('already running');
  });

  test('stop removes descriptor and lock', async () => {
    const d = await boot();
    await d.stop();
    daemon = null;
    expect(existsSync(join(dir, 'daemon.json'))).toBe(false);
    expect(existsSync(join(dir, 'daemon.lock'))).toBe(false);
  });

  test('reclaim runs before tunnels are loaded', async () => {
    const store = memStore(cfgWith('app'));
    daemon = await startDaemon({
      port: 0, stateDir: dir, store, token: 'tok', pids: memPids(), log: () => {}, autoStart: false,
      reclaim: async (s) => {
        const c = s.read()!;
        c.tunnels.app.lastState = 'running';
        s.write(c);
        return ['app'];
      },
    });
    expect(daemon.service.get('app')?.config.lastState).toBe('running');
  });

  test('reclaim is skipped without a token (the tunnels could not be restarted)', async () => {
    let reclaimed = false;
    daemon = await startDaemon({
      port: 0, stateDir: dir, store: memStore(cfgWith('app')), token: '', pids: memPids(), log: () => {},
      reclaim: async () => { reclaimed = true; return []; },
    });
    expect(reclaimed).toBe(false);
  });
});
