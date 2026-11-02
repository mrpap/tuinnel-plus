import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'events';
import { rmSync } from 'fs';
import { writeConfig, readConfig } from '../../src/config/store.js';
import type { TunnelRuntime, TunnelState } from '../../src/types.js';
import { upCommand } from '../../src/commands/up.js';
import { downCommand } from '../../src/commands/down.js';
import { removeCommand } from '../../src/commands/remove.js';
import { statusCommand } from '../../src/commands/status.js';
import { addCommand } from '../../src/commands/add.js';
import { exposeCommand } from '../../src/commands/expose.js';

// Config lives in the sandboxed TUINNEL_HOME (tests/setup/isolate-state.ts).

function runtime(name: string, state: TunnelState, port = 3000): TunnelRuntime {
  return {
    name,
    config: { port, subdomain: name, zone: 'example.com', protocol: 'http' },
    state,
    pid: state === 'stopped' ? null : 4242,
    tunnelId: null,
    publicUrl: `https://${name}.example.com`,
    connectorToken: null,
    metricsPort: null,
    uptime: 0,
    lastError: null,
    connections: [],
  };
}

function fakeClient(tunnels: TunnelRuntime[] = []) {
  const calls: string[] = [];
  const map = new Map(tunnels.map((t) => [t.name, t]));
  const client = Object.assign(new EventEmitter(), {
    calls,
    getAll: () => new Map(map),
    get: (n: string) => map.get(n),
    reload: async () => { calls.push('reload'); },
    start: async (n: string) => {
      calls.push(`start:${n}`);
      if (map.get(n)?.state === 'connected') throw new Error(`Tunnel "${n}" is already running`);
    },
    stop: async (n: string) => { calls.push(`stop:${n}`); },
    delete: async (n: string) => { calls.push(`delete:${n}`); },
    setSelfExpose: async (b: unknown) => { calls.push(`expose:${JSON.stringify(b)}`); return { enabled: true, url: 'https://admin.example.com' }; },
    close: () => { calls.push('close'); },
  });
  return client;
}

let stderr = '';
let stdout = '';
const realErr = process.stderr.write.bind(process.stderr);
const realOut = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  stderr = ''; stdout = '';
  process.exitCode = 0;
  process.stderr.write = ((s: string) => { stderr += s; return true; }) as any;
  process.stdout.write = ((s: string) => { stdout += s; return true; }) as any;
  rmSync(process.env.TUINNEL_HOME!, { recursive: true, force: true });
});

afterEach(() => {
  process.stderr.write = realErr;
  process.stdout.write = realOut;
  process.exitCode = 0;
  rmSync(process.env.TUINNEL_HOME!, { recursive: true, force: true });
});

describe('CLI commands on the daemon', () => {
  test('up starts configured tunnel via daemon and skips already-running', async () => {
    writeConfig({
      version: 1, apiToken: 'tok', defaultZone: 'example.com',
      tunnels: {
        a: { port: 3000, subdomain: 'a', zone: 'example.com', protocol: 'http' },
        b: { port: 3001, subdomain: 'b', zone: 'example.com', protocol: 'http' },
      },
    });
    const client = fakeClient([runtime('a', 'stopped', 3000), runtime('b', 'connected', 3001)]);

    await upCommand(['3000', '3001'], { tui: false }, async () => client as any);

    expect(client.calls).toEqual(['reload', 'start:a', 'start:b', 'close']);
    expect(stderr).toContain('https://a.example.com <- :3000');
    expect(stderr).toContain('already running');
    expect(process.exitCode).toBe(0);
  });

  test('down --all stops every non-stopped tunnel', async () => {
    const client = fakeClient([runtime('a', 'connected'), runtime('b', 'stopped'), runtime('c', 'connecting')]);
    await downCommand([], { all: true }, async () => client as any);
    expect(client.calls).toEqual(['stop:a', 'stop:c', 'close']);
  });

  test('down --clean deletes', async () => {
    const client = fakeClient([runtime('a', 'connected')]);
    await downCommand(['a'], { clean: true }, async () => client as any);
    expect(client.calls).toEqual(['stop:a', 'delete:a', 'close']);
  });

  test('remove prints warnings from delete', async () => {
    const client = fakeClient([runtime('a', 'stopped')]);
    client.delete = async (n: string) => {
      client.calls.push(`delete:${n}`);
      throw new Error(`Removed "${n}", but some Cloudflare resources may remain: DNS record`);
    };
    await removeCommand('a', {}, async () => client as any);
    expect(client.calls).toEqual(['delete:a', 'close']);
    expect(stderr).toContain('may remain: DNS record');
  });

  test('status --json uses daemon when running', async () => {
    const client = fakeClient([runtime('a', 'connected', 1), runtime('b', 'stopped', 2)]);
    await statusCommand({ json: true }, async () => client as any);
    const rows = JSON.parse(stdout);
    expect(rows.map((r: any) => r.name)).toEqual(['a']);
    expect(rows[0].pid).toBe(4242);
    expect(rows[0].publicUrl).toBe('https://a.example.com');
    expect(client.calls).toContain('close');
  });

  test('add reloads a running daemon but does not start one', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: {} });
    const client = fakeClient();
    await addCommand('3000', { subdomain: 'x', zone: 'example.com' }, async () => client as any);
    expect(client.calls).toEqual(['reload', 'close']);
    expect(readConfig()?.tunnels.x?.port).toBe(3000);

    // No daemon running: config is still saved, nothing is started.
    await addCommand('3001', { subdomain: 'y', zone: 'example.com' }, async () => null);
    expect(readConfig()?.tunnels.y?.port).toBe(3001);
    expect(process.exitCode).toBe(0);
  });

  test('expose sets self-expose through the daemon', async () => {
    const client = fakeClient();
    await exposeCommand({ subdomain: 'admin', zone: 'example.com' }, async () => client as any);
    await exposeCommand({ off: true }, async () => client as any);
    expect(client.calls).toEqual([
      'expose:{"enabled":true,"subdomain":"admin","zone":"example.com"}', 'close',
      'expose:{"enabled":false}', 'close',
    ]);
  });

  test('expose without --subdomain explains itself and never calls the daemon', async () => {
    const client = fakeClient();
    await exposeCommand({ zone: 'example.com' }, async () => client as any);
    expect(client.calls).toEqual([]);
    expect(stderr).toContain('--subdomain');
    expect(process.exitCode).toBe(1);
  });

  test('expose falls back to the default zone, and explains when there is none', async () => {
    writeConfig({ version: 1, tunnels: {}, defaultZone: 'example.com' });
    const client = fakeClient();
    await exposeCommand({ subdomain: 'admin' }, async () => client as any);
    expect(client.calls[0]).toBe('expose:{"enabled":true,"subdomain":"admin","zone":"example.com"}');

    writeConfig({ version: 1, tunnels: {} });
    const other = fakeClient();
    await exposeCommand({ subdomain: 'admin' }, async () => other as any);
    expect(other.calls).toEqual([]);
    expect(stderr).toContain('--zone');
  });
});
