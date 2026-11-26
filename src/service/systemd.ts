import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, userInfo } from 'os';
import { dirname, join } from 'path';

export const SYSTEMD_UNIT = 'tuinnel-plus.service';

const HEADER = '# Written by tuinnel-plus service install.';

/** `StandardOutput=append:` arrived in systemd 240; older versions log to the journal. */
const APPEND_LOG_MIN_VERSION = 240;

export interface UnitOptions {
  programArgs: string[];
  envFile: string;
  /** null: leave output to the journal. */
  logFile: string | null;
}

export interface SystemdDeps {
  exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>;
  writeFile(path: string, data: string): void;
  readFile(path: string): string | null;
  removeFile(path: string): void;
  exists(path: string): boolean;
  mkdir(path: string): void;
  user: string;
  home: string;
}

export const defaultDeps: SystemdDeps = {
  exec: (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: `${stdout}${stderr}` });
    });
  }),
  // Owner-only: the environment file can carry an API token
  writeFile: (p, data) => {
    writeFileSync(p, data, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(p, 0o600);
  },
  readFile: (p) => {
    try { return readFileSync(p, 'utf-8'); } catch { return null; }
  },
  removeFile: (p) => unlinkSync(p),
  exists: (p) => existsSync(p),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  user: userInfo().username,
  home: homedir(),
};

export function unitPath(home: string = homedir()): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

/** One ExecStart word: quoted, with systemd's specifiers (%) and variables ($) escaped. */
function execArg(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** The user unit. Pure, so it can be tested without installing. */
export function buildUnit(o: UnitOptions): string {
  const log = o.logFile ? `StandardOutput=append:${o.logFile}\nStandardError=append:${o.logFile}\n` : '';
  return `${HEADER}
[Unit]
Description=tuinnel-plus
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${o.programArgs.map(execArg).join(' ')}
EnvironmentFile=${o.envFile}
Restart=always
RestartSec=2
${log}
[Install]
WantedBy=default.target
`;
}

/** EnvironmentFile lines; double quotes keep values verbatim (systemd does not expand $ or % here). */
export function buildEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`)
    .join('');
}

const systemctl = (deps: SystemdDeps, ...args: string[]) => deps.exec('systemctl', ['--user', ...args]);

async function must(res: Promise<{ code: number; stdout: string }>, what: string): Promise<void> {
  const r = await res;
  if (r.code !== 0) throw new Error(`${what} failed: ${r.stdout.trim() || `exit ${r.code}`}`);
}

async function systemdVersion(deps: SystemdDeps): Promise<number | null> {
  const r = await deps.exec('systemctl', ['--version']);
  const m = /^systemd (\d+)/m.exec(r.stdout);
  return m ? parseInt(m[1], 10) : null;
}

async function lingerOn(deps: SystemdDeps): Promise<boolean> {
  const r = await deps.exec('loginctl', ['show-user', deps.user, '-p', 'Linger', '--value']);
  return r.code === 0 && r.stdout.trim() === 'yes';
}

export interface InstallResult {
  unitPath: string;
  /** A unit was already there (for example one written by hand from the README). */
  replaced: boolean;
  /** on: already enabled; enabled: we turned it on; needs-sudo: still off. */
  linger: 'on' | 'enabled' | 'needs-sudo';
  /** Where output goes, or null when it goes to the journal. */
  logFile: string | null;
}

export async function installService(
  o: { programArgs: string[]; env: Record<string, string>; envFile: string; logFile: string },
  deps: SystemdDeps = defaultDeps,
): Promise<InstallResult> {
  const probe = await systemctl(deps, 'show-environment');
  if (probe.code !== 0) {
    throw new Error(
      `No systemd user instance is reachable (${probe.stdout.trim() || `exit ${probe.code}`}). ` +
      'Run this as your own user in a normal login session, not as root or through sudo.',
    );
  }
  const version = await systemdVersion(deps);
  const logFile = version !== null && version < APPEND_LOG_MIN_VERSION ? null : o.logFile;

  const path = unitPath(deps.home);
  const replaced = deps.exists(path);
  deps.mkdir(dirname(path));
  deps.mkdir(dirname(o.envFile));
  if (logFile) deps.mkdir(dirname(logFile));
  deps.writeFile(o.envFile, buildEnvFile(o.env));
  deps.writeFile(path, buildUnit({ programArgs: o.programArgs, envFile: o.envFile, logFile }));

  await must(systemctl(deps, 'daemon-reload'), 'systemctl --user daemon-reload');
  await must(systemctl(deps, 'enable', SYSTEMD_UNIT), 'systemctl --user enable');
  // restart, not start: an already-running unit must pick up the new ExecStart
  await must(systemctl(deps, 'restart', SYSTEMD_UNIT), 'systemctl --user restart');

  let linger: InstallResult['linger'] = 'on';
  if (!(await lingerOn(deps))) {
    const r = await deps.exec('loginctl', ['enable-linger', '--no-ask-password', deps.user]);
    linger = r.code === 0 ? 'enabled' : 'needs-sudo';
  }
  return { unitPath: path, replaced, linger, logFile };
}

export async function uninstallService(
  envFile: string,
  deps: SystemdDeps = defaultDeps,
): Promise<{ removed: boolean; lingerOn: boolean }> {
  const path = unitPath(deps.home);
  const removed = deps.exists(path);
  await systemctl(deps, 'disable', '--now', SYSTEMD_UNIT); // not installed is fine
  if (removed) deps.removeFile(path);
  if (deps.exists(envFile)) deps.removeFile(envFile);
  await systemctl(deps, 'daemon-reload');
  return { removed, lingerOn: await lingerOn(deps) };
}

export async function serviceStatus(
  deps: SystemdDeps = defaultDeps,
): Promise<{ installed: boolean; active: boolean; pid: number | null; linger: boolean }> {
  const installed = deps.exists(unitPath(deps.home));
  const r = await systemctl(deps, 'show', SYSTEMD_UNIT, '-p', 'ActiveState', '-p', 'MainPID');
  const active = /^ActiveState=active$/m.test(r.stdout);
  const pid = parseInt(/^MainPID=(\d+)$/m.exec(r.stdout)?.[1] ?? '0', 10);
  return { installed, active, pid: pid > 0 ? pid : null, linger: await lingerOn(deps) };
}
