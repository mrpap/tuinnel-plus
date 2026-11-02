import { describe, test, expect } from 'bun:test';
import { TunnelService } from '../../src/services/tunnel-service.js';
import type { TunnelBackend } from '../../src/services/backend.js';
import { memStore, memPids, fakeProc, fakeCf, cfgWith } from './helpers.js';

describe('TunnelService seams', () => {
  test('loadFromConfig reads the injected store', () => {
    const svc = new TunnelService('', memStore(cfgWith('app')), memPids());
    svc.loadFromConfig();
    expect(svc.getAll().has('app')).toBe(true);
  });

  test('TunnelService satisfies TunnelBackend', () => {
    const b: TunnelBackend = new TunnelService('', memStore(cfgWith()), memPids());
    expect(b).toBeDefined();
  });

  test('stop persists lastState stopped to the injected store', async () => {
    const store = memStore(cfgWith('app'));
    store.current.tunnels.app.lastState = 'running';
    const svc = new TunnelService('', store, memPids(), fakeCf());
    svc.loadFromConfig();
    await svc.start('app');
    await svc.stop('app');
    expect(store.current.tunnels.app.lastState).toBe('stopped');
  });
});

describe('TunnelService shutdown', () => {
  test('shutdown keeps lastState running for running tunnels', async () => {
    const cfg = cfgWith('app', 'idle');
    cfg.tunnels.app.lastState = 'running'; // as start() persists it
    const store = memStore(cfg);
    const cf = fakeCf();
    const svc = new TunnelService('', store, memPids(), cf);
    svc.loadFromConfig();
    await svc.start('app');
    await svc.shutdown();
    expect(cf.launched[0].killed).toBe(1);
    expect(store.current.tunnels.app.lastState).toBe('running');
    expect(store.current.tunnels.idle.lastState).toBe('stopped');
  });

  test('shutdown keeps lastState running for tunnels that are not up (e.g. failed auto-start)', async () => {
    const cfg = cfgWith('down1', 'down2');
    cfg.tunnels.down1.lastState = 'running';
    cfg.tunnels.down2.lastState = 'running';
    const store = memStore(cfg);
    const svc = new TunnelService('', store, memPids());
    svc.loadFromConfig();
    await svc.shutdown();
    expect(store.current.tunnels.down1.lastState).toBe('running');
    expect(store.current.tunnels.down2.lastState).toBe('running');
  });
});

describe('TunnelService rename', () => {
  function setup(...names: string[]) {
    const store = memStore(cfgWith(...names));
    const cf = fakeCf();
    const svc = new TunnelService('tok', store, memPids(), cf);
    svc.loadFromConfig();
    const events: string[] = [];
    svc.on('tunnelAdded', ({ name }) => events.push(`+${name}`));
    svc.on('tunnelRemoved', ({ name }) => events.push(`-${name}`));
    return { store, cf, svc, events };
  }

  test('renaming replaces the old tunnel in config, memory and for clients', async () => {
    const { store, cf, svc, events } = setup('app');
    await svc.update('app', { subdomain: 'web' });
    expect(Object.keys(store.current.tunnels)).toEqual(['web']);
    expect([...svc.getAll().keys()]).toEqual(['web']);
    expect(events).toEqual(['-app', '+web']);
    expect(cf.calls).toEqual(['deprovision:app', 'provision:web']);
  });

  test('renaming onto an existing name fails before touching Cloudflare', async () => {
    const { store, cf, svc } = setup('app', 'web');
    await expect(svc.update('app', { subdomain: 'web' })).rejects.toThrow('already exists');
    expect(cf.calls).toEqual([]);
    expect(svc.get('app')).toBeDefined();
    expect(Object.keys(store.current.tunnels).sort()).toEqual(['app', 'web']);
  });

  test('renaming a running tunnel starts it under the new name', async () => {
    const { svc, cf } = setup('app');
    await svc.start('app');
    await svc.update('app', { subdomain: 'web' });
    expect(cf.launched).toHaveLength(2);
    expect(cf.launched[0].killed).toBe(1);
    expect(svc.get('web')!.state).toBe('connecting');
  });
});

describe('TunnelService restart', () => {
  test('a failed restart keeps lastState running so auto-start retries it', async () => {
    const store = memStore(cfgWith('app'));
    const cf = fakeCf();
    const svc = new TunnelService('tok', store, memPids(), cf);
    svc.loadFromConfig();
    await svc.start('app');
    expect(store.current.tunnels.app.lastState).toBe('running');

    cf.launchError = new Error('binary missing');
    await expect(svc.restart('app')).rejects.toThrow('binary missing');
    expect(store.current.tunnels.app.lastState).toBe('running');
    expect(svc.get('app')!.state).toBe('error');
  });
});

describe('TunnelService stop', () => {
  test('stopping never passes through error, even when cloudflared exits non-zero', async () => {
    const cf = { ...fakeCf(), launch: async () => fakeProc(77, null) };
    const svc = new TunnelService('tok', memStore(cfgWith('app')), memPids(), cf);
    svc.loadFromConfig();
    await svc.start('app');
    const states: string[] = [];
    svc.on('stateChange', ({ state }) => states.push(state));
    await svc.stop('app');
    expect(states).not.toContain('error');
    expect(svc.get('app')!.state).toBe('stopped');
    expect(svc.get('app')!.lastError).toBeNull();
  });
});

describe('TunnelService errors', () => {
  test('the error event already carries the error message', async () => {
    const cf = fakeCf();
    cf.launchError = new Error('binary missing');
    const svc = new TunnelService('tok', memStore(cfgWith('app')), memPids(), cf);
    svc.loadFromConfig();
    const seen: Array<string | null> = [];
    svc.on('stateChange', ({ state, tunnel }) => { if (state === 'error') seen.push(tunnel.lastError); });
    await expect(svc.start('app')).rejects.toThrow('binary missing');
    expect(seen).toEqual(['binary missing']);
  });

  test('starting again clears the previous error', async () => {
    const cf = fakeCf();
    cf.launchError = new Error('binary missing');
    const svc = new TunnelService('tok', memStore(cfgWith('app')), memPids(), cf);
    svc.loadFromConfig();
    await expect(svc.start('app')).rejects.toThrow();
    cf.launchError = null;
    await svc.start('app');
    expect(svc.get('app')!.lastError).toBeNull();
  });

  test('a crash event already carries the exit message', async () => {
    const cf = fakeCf();
    const svc = new TunnelService('tok', memStore(cfgWith('app')), memPids(), cf);
    svc.loadFromConfig();
    await svc.start('app');
    const seen: Array<string | null> = [];
    svc.on('stateChange', ({ state, tunnel }) => { if (state === 'error') seen.push(tunnel.lastError); });
    (cf.launched[0].child as any).emit('exit', 1);
    expect(seen).toEqual(['cloudflared exited with code 1']);
  });
});
