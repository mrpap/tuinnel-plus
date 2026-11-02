import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync,
} from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

/** What a running daemon publishes so local clients (TUI/CLI) can find and authenticate to it. */
export interface DaemonDescriptor {
  pid: number;
  host: string;
  port: number;
  localToken: string;
  version: string;
  startedAt: number;
}

export class DaemonRunningError extends Error {
  constructor(public readonly pid: number) {
    super(`tuinnel-plus daemon already running (pid ${pid})`);
    this.name = 'DaemonRunningError';
  }
}

export function daemonPaths(stateDir: string) {
  const logDir = join(stateDir, 'logs');
  return {
    descriptor: join(stateDir, 'daemon.json'),
    lock: join(stateDir, 'daemon.lock'),
    logDir,
    logFile: join(logDir, 'daemon.log'),
  };
}

function ensureStateDir(stateDir: string): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o700);
  }
}

export function writeDescriptor(stateDir: string, d: DaemonDescriptor): void {
  ensureStateDir(stateDir);
  const { descriptor } = daemonPaths(stateDir);
  const tmp = descriptor + '.tmp';
  writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, descriptor);
}

export function readDescriptor(stateDir: string): DaemonDescriptor | null {
  try {
    const d = JSON.parse(readFileSync(daemonPaths(stateDir).descriptor, 'utf-8'));
    if (typeof d?.pid !== 'number' || typeof d?.port !== 'number' || typeof d?.localToken !== 'string') return null;
    return d as DaemonDescriptor;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is a running tuinnel-plus daemon. A bare liveness check isn't
 * enough: after a crash or power loss the old pid is often reused by another
 * process at boot, and honouring that stale lock would keep every tunnel down.
 */
export function isDaemonProcess(pid: number): boolean {
  if (pid === process.pid) return true; // this process already took the lock
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH: gone. EPERM: another user's process — the daemon runs as us.
    return false;
  }
  let command: string;
  try {
    command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8', timeout: 2000 });
  } catch {
    return true; // can't tell — keep honouring the lock
  }
  return /\bserve\b/.test(command) && /tuinnel|index\.(js|ts)/.test(command);
}

function readLockPid(lock: string): number | null {
  try {
    const pid = parseInt(readFileSync(lock, 'utf-8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Take the single-instance lock, or throw DaemonRunningError if a live daemon holds it. */
export function acquireLock(
  stateDir: string,
  pid: number = process.pid,
  isAlive: (pid: number) => boolean = isDaemonProcess,
): void {
  ensureStateDir(stateDir);
  const { lock } = daemonPaths(stateDir);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readLockPid(lock);
      if (holder !== null && isAlive(holder)) {
        throw new DaemonRunningError(holder);
      }
      unlinkSync(lock); // stale — take it over
    }
  }
  throw new Error(`Could not acquire daemon lock at ${lock}`);
}

/** Remove the lock and descriptor, but only if they belong to `pid`. */
export function releaseLock(stateDir: string, pid: number = process.pid): void {
  const { lock, descriptor } = daemonPaths(stateDir);
  if (readLockPid(lock) === pid) {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
  if (readDescriptor(stateDir)?.pid === pid) {
    try { unlinkSync(descriptor); } catch { /* already gone */ }
  }
}
