import { spawn } from 'child_process';
import { closeSync, mkdirSync, openSync } from 'fs';
import { resolveStateDir } from '../config/paths.js';
import { daemonPaths, readDescriptor, type DaemonDescriptor } from '../daemon/descriptor.js';

const POLL_MS = 100;
const HEALTH_TIMEOUT_MS = 1000;

async function healthy(d: DaemonDescriptor): Promise<boolean> {
  try {
    const res = await fetch(`http://${d.host}:${d.port}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The running daemon, or null if its descriptor is missing or it doesn't answer. */
export async function findDaemon(
  stateDir: string = resolveStateDir(),
  probe: (d: DaemonDescriptor) => Promise<boolean> = healthy,
): Promise<DaemonDescriptor | null> {
  const d = readDescriptor(stateDir);
  return d && (await probe(d)) ? d : null;
}

/** Start `tuinnel-plus serve` detached, logging to the daemon log file. */
function spawnServe(stateDir: string): void {
  const { logDir, logFile } = daemonPaths(stateDir);
  mkdirSync(logDir, { recursive: true });
  const fd = openSync(logFile, 'a');
  try {
    spawn(process.execPath, [...process.execArgv, process.argv[1], 'serve'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    }).unref();
  } finally {
    closeSync(fd);
  }
}

/** Connect to the running daemon, starting one in the background if needed. */
export async function ensureDaemon(o: {
  stateDir?: string;
  timeoutMs?: number;
  spawnDaemon?: () => void;
  probe?: (d: DaemonDescriptor) => Promise<boolean>;
} = {}): Promise<DaemonDescriptor> {
  const stateDir = o.stateDir ?? resolveStateDir();
  const probe = o.probe ?? healthy;

  const existing = await findDaemon(stateDir, probe);
  if (existing) return existing;

  (o.spawnDaemon ?? (() => spawnServe(stateDir)))();

  const deadline = Date.now() + (o.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const d = await findDaemon(stateDir, probe);
    if (d) return d;
  }
  throw new Error(`Background service failed to start — see ${daemonPaths(stateDir).logFile}`);
}
