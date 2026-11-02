import { execFileSync } from 'child_process';
import { readPids, removePid, isProcessAlive } from '../cloudflared/pid.js';
import type { ConfigStore } from '../config/store.js';

export interface ReclaimDeps {
  readPids: () => Record<string, { pid: number; startedAt: number }>;
  removePid: (name: string) => void;
  isAlive: (pid: number) => boolean;
  processName: (pid: number) => string;
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  /** Resolves true once the process has exited, false on timeout. */
  waitExit: (pid: number, timeoutMs: number) => Promise<boolean>;
}

const EXIT_TIMEOUT_MS = 5000;

const defaultDeps: ReclaimDeps = {
  readPids,
  removePid,
  isAlive: isProcessAlive,
  processName: (pid) => {
    try {
      return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' }).trim();
    } catch {
      return '';
    }
  },
  kill: (pid, signal) => {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  },
  waitExit: async (pid, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return !isProcessAlive(pid);
  },
};

/**
 * Take ownership of tunnels started outside the daemon (by another tuinnel-plus
 * process, or a crashed daemon's orphaned cloudflared). Each live
 * cloudflared listed in the pid file is stopped and its tunnel marked
 * lastState 'running', so the daemon's autoStart brings it back under its own
 * management instead of spawning a duplicate connector. Call before
 * TunnelService.loadFromConfig(). Returns the reclaimed tunnel names.
 */
export async function reclaimExternal(store: ConfigStore, deps: ReclaimDeps = defaultDeps): Promise<string[]> {
  const reclaimed: string[] = [];

  for (const [name, { pid }] of Object.entries(deps.readPids())) {
    // A reused pid could belong to anything — only touch cloudflared.
    if (deps.isAlive(pid) && deps.processName(pid).includes('cloudflared')) {
      deps.kill(pid, 'SIGTERM');
      if (!(await deps.waitExit(pid, EXIT_TIMEOUT_MS))) deps.kill(pid, 'SIGKILL');
      reclaimed.push(name);
    }
    deps.removePid(name);
  }

  if (reclaimed.length > 0) {
    const config = store.read();
    if (config) {
      for (const name of reclaimed) {
        if (config.tunnels[name]) config.tunnels[name] = { ...config.tunnels[name], lastState: 'running' };
      }
      store.write(config);
    }
  }

  return reclaimed;
}
