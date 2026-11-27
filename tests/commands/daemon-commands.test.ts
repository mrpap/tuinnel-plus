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
import { savePassword } from '../../src/commands/password.js';
import { verifyPassword } from '../../src/daemon/auth.js';
import { DaemonRequestError } from '../../src/client/daemon-client.js';

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
    // Like the service: reload adds tunnels from the config file that it doesn't know yet.
    reload: async () => {
      calls.push('reload');
      for (const [name, tc] of Object.entries(readConfig()?.tunnels ?? {})) {
        if (!map.has(name)) map.set(name, { ...runtime(name, 'stopped', tc.port), config: { ...tc } });
      }
    },
    create: async (o: { port: number; subdomain: string; zone: string }) => {
      calls.push(`create:${o.subdomain}:${o.port}:${o.zone}`);
      map.set(o.subdomain, runtime(o.subdomain, 'stopped', o.port));
      return o.subdomain;
    },
    setPassword: async () => { calls.push('setPassword'); },
    reloadPassword: async () => { calls.push('reloadPassword'); },
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

  test('add creates the tunnel through a running service and leaves the config file to it', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: {} });
    const client = fakeClient();
    await addCommand('3000', { subdomain: 'x' }, async () => client as any);
    expect(client.calls).toEqual(['reload', 'create:x:3000:example.com', 'close']);
    expect(readConfig()?.tunnels.x).toBeUndefined();
    expect(stderr).toContain('Added tunnel "x"');
    expect(stderr).toContain('tuinnel-plus up 3000');
    expect(process.exitCode).toBe(0);
  });

  test('add refuses a name the running service already has', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: {} });
    const client = fakeClient([runtime('x', 'stopped', 4000)]);
    await addCommand('3000', { subdomain: 'x', zone: 'example.com' }, async () => client as any);
    expect(client.calls).toEqual(['reload', 'close']);
    expect(stderr).toContain('already exists');
    expect(process.exitCode).toBe(1);
  });

  test('add without a running service saves to the config file and starts nothing', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: {} });
    await addCommand('3001', { subdomain: 'y', zone: 'example.com' }, async () => null);
    expect(readConfig()?.tunnels.y?.port).toBe(3001);
    expect(process.exitCode).toBe(0);
  });

  test('add tells a service that came up meanwhile to read the file it just wrote', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: {} });
    const client = fakeClient();
    let asks = 0;
    await addCommand('3001', { subdomain: 'y', zone: 'example.com' }, async () => (asks++ === 0 ? null : client as any));
    expect(readConfig()?.tunnels.y?.port).toBe(3001);
    expect(client.calls).toEqual(['reload', 'close']);
  });

  test('add refuses a name that is only in the config file, which the service reads first', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: { x: { port: 4000, subdomain: 'x', zone: 'example.com', protocol: 'http' } } });
    const client = fakeClient();
    await addCommand('3000', { subdomain: 'x' }, async () => client as any);
    expect(client.calls).toEqual(['reload', 'close']);
    expect(stderr).toContain('already exists');
    expect(process.exitCode).toBe(1);
  });

  test('up starts a tunnel that is only in the config file', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: { foo: { port: 3000, subdomain: 'foo', zone: 'example.com', protocol: 'http' } } });
    const client = fakeClient();
    await upCommand(['3000'], { tui: false }, async () => client as any);
    expect(client.calls).toEqual(['reload', 'start:foo', 'close']);
  });

  test('add still succeeds when a service that came up meanwhile cannot be told', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: {} });
    const client = fakeClient();
    client.reload = async () => { throw new Error('connection reset'); };
    let asks = 0;
    await addCommand('3002', { subdomain: 'z', zone: 'example.com' }, async () => (asks++ === 0 ? null : client as any));
    expect(readConfig()?.tunnels.z?.port).toBe(3002);
    expect(process.exitCode).toBe(0);
  });

  test('add reports a tunnel the service could not create', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: {} });
    const client = fakeClient();
    client.create = async () => { throw new Error('No Cloudflare API token configured. Run `tuinnel-plus init` first.'); };
    await addCommand('3000', { subdomain: 'x' }, async () => client as any);
    expect(stderr).toContain('No Cloudflare API token configured');
    expect(process.exitCode).toBe(1);
  });

  test('add warns when another tunnel already uses the port', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: {} });
    const client = fakeClient([runtime('other', 'stopped', 3000)]);
    await addCommand('3000', { subdomain: 'x' }, async () => client as any);
    expect(stderr).toContain('Port 3000 is also used by "other"');
    expect(process.exitCode).toBe(0);
  });

  test('up creates a new tunnel through the service, then starts it', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: {} });
    const client = fakeClient();
    await upCommand(['4000'], { tui: false, subdomain: 'n' }, async () => client as any);
    expect(client.calls).toEqual(['reload', 'create:n:4000:example.com', 'start:n', 'close']);
    expect(readConfig()?.tunnels.n).toBeUndefined();
    expect(stderr).toContain('https://n.example.com <- :4000');
  });

  test('up finds tunnels the service knows even if the config file is stale', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: {} });
    const client = fakeClient([runtime('web', 'stopped', 5000)]);
    await upCommand(['5000'], { tui: false }, async () => client as any);
    expect(client.calls).toEqual(['reload', 'start:web', 'close']);
  });

  test('up with one subdomain for two ports creates it once, even before the service reports it back', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: {} });
    const client = fakeClient();
    // The real client learns about a new tunnel from a live event that can arrive after create returns.
    client.create = async (o: any) => { client.calls.push(`create:${o.subdomain}:${o.port}:${o.zone}`); return o.subdomain; };
    await upCommand(['3000', '3001'], { tui: false, subdomain: 'x' }, async () => client as any);
    expect(client.calls.filter((c) => c.startsWith('create:'))).toEqual(['create:x:3000:example.com']);
    expect(process.exitCode).toBe(0);
  });

  test('up keeps going when one new tunnel cannot be created, and fails when none start', async () => {
    writeConfig({ version: 1, apiToken: 'tok', defaultZone: 'example.com', tunnels: {} });
    const client = fakeClient([runtime('ok', 'stopped', 3000)]);
    client.create = async (o: any) => { client.calls.push(`create:${o.subdomain}`); throw new Error('Zone not found'); };
    await upCommand(['3000', '3001'], { tui: false, subdomain: 'bad' }, async () => client as any);
    expect(client.calls).toEqual(['reload', 'create:bad', 'start:ok', 'close']);
    expect(stderr).toContain('Failed to create tunnel "bad": Zone not found');
    expect(process.exitCode).toBe(0);

    stderr = '';
    const none = fakeClient();
    none.create = async () => { throw new Error('Zone not found'); };
    await upCommand(['4000'], { tui: false, subdomain: 'bad' }, async () => none as any);
    expect(stderr).toContain('No tunnels started');
    expect(process.exitCode).toBe(1);
  });

  test('password set goes through a running service', async () => {
    const client = fakeClient();
    expect(await savePassword('brand-new-password', 'brand-new-password', async () => client as any)).toBeNull();
    expect(client.calls).toEqual(['setPassword', 'close']);
    expect(readConfig()?.web?.passwordHash).toBeUndefined();
  });

  test('password set falls back to the file when the running service is older', async () => {
    const client = fakeClient();
    client.setPassword = async () => { client.calls.push('setPassword'); throw new DaemonRequestError('Not found', 404); };
    expect(await savePassword('brand-new-password', 'brand-new-password', async () => client as any)).toBeNull();
    expect(client.calls).toEqual(['setPassword', 'reloadPassword', 'close']);
    expect(verifyPassword('brand-new-password', readConfig()!.web!.passwordHash!)).toBe(true);
  });

  test('password set tells a service that came up meanwhile to read the new hash', async () => {
    const client = fakeClient();
    let asks = 0;
    expect(await savePassword('brand-new-password', 'brand-new-password', async () => (asks++ === 0 ? null : client as any))).toBeNull();
    expect(verifyPassword('brand-new-password', readConfig()!.web!.passwordHash!)).toBe(true);
    expect(client.calls).toEqual(['reloadPassword', 'close']);
  });

  test('password set still succeeds when the older service cannot be told to reload', async () => {
    const client = fakeClient();
    client.setPassword = async () => { throw new DaemonRequestError('Not found', 404); };
    client.reloadPassword = async () => { throw new Error('connection reset'); };
    expect(await savePassword('brand-new-password', 'brand-new-password', async () => client as any)).toBeNull();
    expect(verifyPassword('brand-new-password', readConfig()!.web!.passwordHash!)).toBe(true);
    expect(stderr).toContain('signed in');
  });

  test('password set without a running service writes the file; bad input changes nothing', async () => {
    expect(await savePassword('brand-new-password', 'brand-new-password', async () => null)).toBeNull();
    expect(verifyPassword('brand-new-password', readConfig()!.web!.passwordHash!)).toBe(true);
    const client = fakeClient();
    expect(await savePassword('one-password', 'another-one', async () => client as any)).toBe('Passwords do not match.');
    expect(await savePassword('short', 'short', async () => client as any)).toContain('at least');
    expect(client.calls).toEqual([]);
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
