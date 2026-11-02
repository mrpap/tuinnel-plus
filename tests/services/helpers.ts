import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { Config } from '../../src/config/schema.js';
import type { ConfigStore } from '../../src/config/store.js';
import type { CloudflaredProcess } from '../../src/cloudflared/process.js';
import type { PidOps, CloudflareOps } from '../../src/services/tunnel-service.js';

export function memStore(initial: Config): ConfigStore & { current: Config } {
  const store = {
    current: structuredClone(initial),
    read: () => structuredClone(store.current),
    write: (c: Config) => { store.current = structuredClone(c); },
  };
  return store;
}

/** In-memory pid ops so tests never touch the real pid file. */
export function memPids(): PidOps & { entries: Map<string, number> } {
  const entries = new Map<string, number>();
  return {
    entries,
    write: (name, pid) => { entries.set(name, pid); },
    remove: (name) => { entries.delete(name); },
  };
}

/** `exitCode` is what the process reports when killed; real cloudflared gives null on SIGTERM. */
export function fakeProc(pid = 4242, exitCode: number | null = 0): CloudflaredProcess & { killed: number } {
  const child = new EventEmitter() as unknown as ChildProcess;
  const proc = {
    child,
    pid,
    killed: 0,
    async kill() {
      proc.killed++;
      (child as unknown as EventEmitter).emit('exit', exitCode);
    },
    onStderr() {},
  };
  return proc;
}

export function cfgWith(...names: string[]): Config {
  const tunnels: Config['tunnels'] = {};
  for (const n of names) {
    tunnels[n] = { port: 3000, subdomain: n, zone: 'example.com', protocol: 'http', lastState: 'stopped' };
  }
  return { version: 1, tunnels };
}

/** In-memory Cloudflare: records calls, never touches the network or spawns cloudflared. */
export function fakeCf(): CloudflareOps & {
  calls: string[];
  launched: Array<ReturnType<typeof fakeProc>>;
  launchError: Error | null;
} {
  const calls: string[] = [];
  const launched: Array<ReturnType<typeof fakeProc>> = [];
  const cf = {
    calls,
    launched,
    launchError: null as Error | null,
    async provision(spec) {
      calls.push(`provision:${spec.name}`);
      return { tunnelId: spec.tunnelId ?? `tid-${spec.name}`, connectorToken: spec.connectorToken ?? `tok-${spec.name}` };
    },
    async deprovision(name) {
      calls.push(`deprovision:${name}`);
      return [];
    },
    async launch() {
      if (cf.launchError) throw cf.launchError;
      const proc = fakeProc(5000 + launched.length);
      launched.push(proc);
      return proc;
    },
  };
  return cf;
}
