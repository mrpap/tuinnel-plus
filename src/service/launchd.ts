import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export const LAUNCHD_LABEL = 'io.github.mrpap.tuinnel-plus';

export interface PlistOptions {
  programArgs: string[];
  env: Record<string, string>;
  logFile: string;
}

export interface LaunchdDeps {
  exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>;
  writeFile(path: string, data: string): void;
  removeFile(path: string): void;
  exists(path: string): boolean;
  mkdir(path: string): void;
  sleep(ms: number): Promise<void>;
  uid: number;
  home: string;
}

export const defaultDeps: LaunchdDeps = {
  exec: (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: `${stdout}${stderr}` });
    });
  }),
  // Owner-only: the environment block can carry an API token
  writeFile: (p, data) => {
    writeFileSync(p, data, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(p, 0o600);
  },
  removeFile: (p) => unlinkSync(p),
  exists: (p) => existsSync(p),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  uid: process.getuid?.() ?? 501,
  home: homedir(),
};

export function plistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The launchd agent definition. Pure, so it can be tested without installing. */
export function buildPlist(o: PlistOptions): string {
  const args = o.programArgs.map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const env = Object.entries(o.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>StandardOutPath</key>
  <string>${xml(o.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.logFile)}</string>
</dict>
</plist>
`;
}

const target = (deps: LaunchdDeps) => `gui/${deps.uid}/${LAUNCHD_LABEL}`;

/** How long a freshly loaded agent must survive before install calls it running. */
const SETTLE_MS = 3000;

export async function installService(
  o: PlistOptions,
  deps: LaunchdDeps = defaultDeps,
): Promise<{ path: string; running: boolean }> {
  const path = plistPath(deps.home);
  deps.mkdir(dirname(path));
  deps.mkdir(dirname(o.logFile));
  deps.writeFile(path, buildPlist(o));
  await deps.exec('launchctl', ['bootout', target(deps)]); // not loaded yet is fine
  const res = await deps.exec('launchctl', ['bootstrap', `gui/${deps.uid}`, path]);
  if (res.code !== 0) throw new Error(`launchctl bootstrap failed: ${res.stdout.trim() || `exit ${res.code}`}`);

  // bootstrap returns once the job is loaded; a serve that exits at once (port taken by a
  // daemon the dashboard started, say) only shows as a stopped job or a recorded exit.
  await deps.sleep(SETTLE_MS);
  const info = await deps.exec('launchctl', ['print', target(deps)]);
  const running = /^\tstate = running$/m.test(info.stdout) && /^\tlast exit code = \(never exited\)$/m.test(info.stdout);
  return { path, running };
}

export async function uninstallService(deps: LaunchdDeps = defaultDeps): Promise<void> {
  const path = plistPath(deps.home);
  await deps.exec('launchctl', ['bootout', target(deps)]);
  if (deps.exists(path)) deps.removeFile(path);
}

export async function serviceStatus(
  deps: LaunchdDeps = defaultDeps,
): Promise<{ installed: boolean; loaded: boolean; pid: number | null }> {
  const installed = deps.exists(plistPath(deps.home));
  const res = await deps.exec('launchctl', ['print', target(deps)]);
  if (res.code !== 0) return { installed, loaded: false, pid: null };
  const m = /^\s*pid = (\d+)/m.exec(res.stdout);
  return { installed, loaded: true, pid: m ? parseInt(m[1], 10) : null };
}
