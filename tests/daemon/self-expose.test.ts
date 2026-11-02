import { describe, test, expect } from 'bun:test';
import { SelfExpose } from '../../src/daemon/self-expose.js';
import { PartialDeleteError } from '../../src/services/tunnel-service.js';
import { memStore, cfgWith } from '../services/helpers.js';
import { FakeBackend } from './helpers.js';

const DAEMON_PORT = 8484;

function withPassword() {
  const store = memStore(cfgWith());
  store.current.web = { passwordHash: 'scrypt$aa$bb' };
  return store;
}

describe('SelfExpose', () => {
  test('enable refused without password', async () => {
    const backend = new FakeBackend();
    const se = new SelfExpose(backend, memStore(cfgWith()), DAEMON_PORT);
    await expect(se.enable('admin', 'example.com')).rejects.toThrow('Set a password before exposing the admin UI.');
    expect(backend.calls).toEqual([]);
  });

  test('enable creates+starts tunnel to daemon port and persists', async () => {
    const backend = new FakeBackend();
    const store = withPassword();
    const se = new SelfExpose(backend, store, DAEMON_PORT);
    await se.enable('admin', 'example.com');
    expect(backend.calls).toEqual(['create', 'start']);
    expect(backend.tunnels.get('admin')!.config.port).toBe(DAEMON_PORT);
    expect(store.current.web!.selfExpose).toEqual({ enabled: true, subdomain: 'admin', zone: 'example.com' });
    expect(se.status()).toEqual({ enabled: true, subdomain: 'admin', zone: 'example.com', url: 'https://admin.example.com' });
    expect(se.isSystemTunnel('admin')).toBe(true);
    expect(store.current.web!.passwordHash).toBe('scrypt$aa$bb');
  });

  test('enable refuses name clash with user tunnel', async () => {
    const backend = new FakeBackend('admin');
    const se = new SelfExpose(backend, withPassword(), DAEMON_PORT);
    await expect(se.enable('admin', 'example.com')).rejects.toThrow('already exists');
    expect(backend.calls).toEqual([]);
  });

  test('enable with a new hostname replaces the old system tunnel', async () => {
    const backend = new FakeBackend();
    const se = new SelfExpose(backend, withPassword(), DAEMON_PORT);
    await se.enable('admin', 'example.com');
    await se.enable('panel', 'example.com');
    expect(backend.tunnels.has('admin')).toBe(false);
    expect(backend.tunnels.has('panel')).toBe(true);
    expect(se.isSystemTunnel('panel')).toBe(true);
    expect(se.isSystemTunnel('admin')).toBe(false);
  });

  test('disable deletes tunnel and persists enabled:false', async () => {
    const backend = new FakeBackend();
    const store = withPassword();
    const se = new SelfExpose(backend, store, DAEMON_PORT);
    await se.enable('admin', 'example.com');
    backend.failWith.delete = new PartialDeleteError('admin', ['DNS left']);
    await se.disable();
    expect(backend.tunnels.has('admin')).toBe(false);
    expect(store.current.web!.selfExpose).toEqual({ enabled: false, subdomain: 'admin', zone: 'example.com' });
    expect(se.isSystemTunnel('admin')).toBe(false);
    expect(se.status().url).toBeNull();
  });

  test('ensure starts a configured system tunnel', async () => {
    const backend = new FakeBackend('admin');
    backend.tunnels.get('admin')!.config.port = DAEMON_PORT;
    const store = withPassword();
    store.current.web!.selfExpose = { enabled: true, subdomain: 'admin', zone: 'example.com' };
    const se = new SelfExpose(backend, store, DAEMON_PORT);
    await se.ensure();
    expect(backend.calls).toEqual(['start']);
    expect(backend.tunnels.get('admin')!.state).toBe('connected');
  });

  test('ensure points an existing system tunnel at the current daemon port', async () => {
    const backend = new FakeBackend('admin'); // created when the daemon ran on another port
    backend.tunnels.get('admin')!.config.port = 9999;
    const store = withPassword();
    store.current.web!.selfExpose = { enabled: true, subdomain: 'admin', zone: 'example.com' };
    await new SelfExpose(backend, store, DAEMON_PORT).ensure();
    expect(backend.calls).toEqual(['update', 'start']);
    expect(backend.tunnels.get('admin')!.config.port).toBe(DAEMON_PORT);
  });

  test('ensure recreates a missing system tunnel', async () => {
    const backend = new FakeBackend();
    const store = withPassword();
    store.current.web!.selfExpose = { enabled: true, subdomain: 'admin', zone: 'example.com' };
    await new SelfExpose(backend, store, DAEMON_PORT).ensure();
    expect(backend.calls).toEqual(['create', 'start']);
  });

  test('ensure does nothing without a password', async () => {
    const backend = new FakeBackend('admin');
    const store = memStore(cfgWith());
    store.current.web = { selfExpose: { enabled: true, subdomain: 'admin', zone: 'example.com' } };
    await new SelfExpose(backend, store, DAEMON_PORT).ensure();
    expect(backend.calls).toEqual([]);
  });
});

describe('SelfExpose event ordering', () => {
  test('the tunnel is already flagged system when its first events fire', async () => {
    const backend = new FakeBackend();
    const se = new SelfExpose(backend, withPassword(), DAEMON_PORT);
    const seen: boolean[] = [];
    backend.on('tunnelAdded', ({ name }) => seen.push(se.isSystemTunnel(name)));
    await se.enable('admin', 'example.com');
    expect(seen).toEqual([true]);
  });

  test('a failed enable rolls the setting back', async () => {
    const backend = new FakeBackend();
    backend.failWith.start = new Error('cloudflared failed');
    const store = withPassword();
    const se = new SelfExpose(backend, store, DAEMON_PORT);
    await expect(se.enable('admin', 'example.com')).rejects.toThrow('cloudflared failed');
    expect(store.current.web!.selfExpose).toBeUndefined();
    expect(se.isSystemTunnel('admin')).toBe(false);
  });
});
