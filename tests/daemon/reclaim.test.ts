import { describe, test, expect } from 'bun:test';
import { reclaimExternal, type ReclaimDeps } from '../../src/daemon/reclaim.js';
import { memStore, cfgWith } from '../services/helpers.js';

function deps(pids: Record<string, number>, alive: Set<number>, names: Record<number, string>) {
  const killed: Array<[number, string]> = [];
  const removed: string[] = [];
  const d: ReclaimDeps = {
    readPids: () => Object.fromEntries(Object.entries(pids).map(([n, pid]) => [n, { pid, startedAt: 0 }])),
    removePid: (n) => { removed.push(n); },
    isAlive: (pid) => alive.has(pid),
    processName: (pid) => names[pid] ?? '',
    kill: (pid, sig) => { killed.push([pid, sig]); if (sig === 'SIGTERM') alive.delete(pid); },
    waitExit: async (pid) => !alive.has(pid),
  };
  return { d, killed, removed };
}

describe('reclaimExternal', () => {
  test('live cloudflared pid is killed and marked running', async () => {
    const store = memStore(cfgWith('app'));
    const { d, killed, removed } = deps({ app: 100 }, new Set([100]), { 100: '/usr/local/bin/cloudflared' });
    const names = await reclaimExternal(store, d);
    expect(names).toEqual(['app']);
    expect(killed).toEqual([[100, 'SIGTERM']]);
    expect(removed).toEqual(['app']);
    expect(store.current.tunnels.app.lastState).toBe('running');
  });

  test('stubborn process gets SIGKILL after SIGTERM', async () => {
    const store = memStore(cfgWith('app'));
    const alive = new Set([100]);
    const { d, killed } = deps({ app: 100 }, alive, { 100: 'cloudflared' });
    d.kill = (pid, sig) => { killed.push([pid, sig]); if (sig === 'SIGKILL') alive.delete(pid); };
    await reclaimExternal(store, d);
    expect(killed).toEqual([[100, 'SIGTERM'], [100, 'SIGKILL']]);
  });

  test('live non-cloudflared pid is left alone', async () => {
    const store = memStore(cfgWith('app'));
    const { d, killed, removed } = deps({ app: 100 }, new Set([100]), { 100: 'postgres' });
    expect(await reclaimExternal(store, d)).toEqual([]);
    expect(killed).toEqual([]);
    expect(removed).toEqual(['app']);
    expect(store.current.tunnels.app.lastState).toBe('stopped');
  });

  test('dead pid entry is just removed', async () => {
    const store = memStore(cfgWith('app'));
    const { d, killed, removed } = deps({ app: 100 }, new Set(), {});
    expect(await reclaimExternal(store, d)).toEqual([]);
    expect(killed).toEqual([]);
    expect(removed).toEqual(['app']);
  });

  test('reclaimed tunnel without a config entry is not added to config', async () => {
    const store = memStore(cfgWith());
    const { d } = deps({ ghost: 100 }, new Set([100]), { 100: 'cloudflared' });
    expect(await reclaimExternal(store, d)).toEqual(['ghost']);
    expect(store.current.tunnels).toEqual({});
  });
});
