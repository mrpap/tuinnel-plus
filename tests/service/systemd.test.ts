import { describe, test, expect } from 'bun:test';
import {
  SYSTEMD_UNIT, unitPath, buildUnit, buildEnvFile, installService, uninstallService, serviceStatus,
  type SystemdDeps,
} from '../../src/service/systemd.js';

const UNIT = '/home/me/.config/systemd/user/tuinnel-plus.service';
const ENV_FILE = '/home/me/.tuinnel/service.env';
const LOG = '/home/me/.tuinnel/logs/daemon.log';

const opts = {
  programArgs: ['/usr/bin/node', '/opt/tp/dist/index.js', 'serve'],
  env: { PATH: '/usr/bin:/bin', CLOUDFLARE_API_TOKEN: 'tok' },
  envFile: ENV_FILE,
  logFile: LOG,
};

type Reply = { code: number; stdout: string };

/** Fake systemctl/loginctl: replies keyed by the command line, default success with no output. */
function fakeDeps(replies: Record<string, Reply> = {}, over: Partial<SystemdDeps> = {}) {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const deps: SystemdDeps = {
    exec: async (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      return replies[line] ?? { code: 0, stdout: '' };
    },
    writeFile: (p, data) => { calls.push(`write ${p}`); files.set(p, data); },
    readFile: (p) => files.get(p) ?? null,
    removeFile: (p) => { calls.push(`rm ${p}`); files.delete(p); },
    exists: (p) => files.has(p),
    mkdir: () => {},
    user: 'me',
    home: '/home/me',
    ...over,
  };
  return { deps, calls, files };
}

const VERSION = 'systemctl --version';
const LINGER = 'loginctl show-user me -p Linger --value';
const ENABLE_LINGER = 'loginctl enable-linger --no-ask-password me';

describe('systemd unit', () => {
  test('name and path', () => {
    expect(SYSTEMD_UNIT).toBe('tuinnel-plus.service');
    expect(unitPath('/home/me')).toBe(UNIT);
  });

  test('unit runs the current install with serve, restarts, starts at boot', () => {
    const u = buildUnit({ programArgs: opts.programArgs, envFile: ENV_FILE, logFile: LOG });
    expect(u).toStartWith('# Written by tuinnel-plus service install.');
    expect(u).toContain('ExecStart="/usr/bin/node" "/opt/tp/dist/index.js" "serve"');
    expect(u).toContain(`EnvironmentFile=${ENV_FILE}`);
    expect(u).toContain('Restart=always');
    expect(u).toContain('After=network-online.target');
    expect(u).toContain('WantedBy=default.target');
    expect(u).toContain(`StandardOutput=append:${LOG}`);
    expect(u).toContain(`StandardError=append:${LOG}`);
  });

  test('no log lines when logFile is null (systemd < 240 logs to the journal)', () => {
    const u = buildUnit({ programArgs: opts.programArgs, envFile: ENV_FILE, logFile: null });
    expect(u).not.toContain('StandardOutput');
    expect(u).not.toContain('StandardError');
  });

  test('ExecStart quotes spaces and escapes " \\ % $', () => {
    const u = buildUnit({ programArgs: ['/home/a b/node', '/x/100%/$HOME/"q"\\', 'serve'], envFile: '/e', logFile: null });
    expect(u).toContain('ExecStart="/home/a b/node" "/x/100%%/$$HOME/\\"q\\"\\\\" "serve"');
  });

  test('env file round-trips tricky values', () => {
    expect(buildEnvFile({ CLOUDFLARE_API_TOKEN: 'a"b\\c$d%e', PATH: '/usr/bin' }))
      .toBe('CLOUDFLARE_API_TOKEN="a\\"b\\\\c$d%e"\nPATH="/usr/bin"\n');
  });
});

describe('installService', () => {
  test('writes unit + env file, reloads, enables, restarts', async () => {
    const { deps, calls, files } = fakeDeps({
      [VERSION]: { code: 0, stdout: 'systemd 255 (255.4-1ubuntu8)\n+PAM +AUDIT' },
      [LINGER]: { code: 0, stdout: 'yes\n' },
    });
    const r = await installService(opts, deps);

    expect(r).toEqual({ unitPath: UNIT, replaced: false, linger: 'on', logFile: LOG });
    expect(files.get(ENV_FILE)).toBe('PATH="/usr/bin:/bin"\nCLOUDFLARE_API_TOKEN="tok"\n');
    expect(files.get(UNIT)).toContain(`EnvironmentFile=${ENV_FILE}`);
    const systemctl = calls.filter((c) => c.startsWith('systemctl --user'));
    expect(systemctl).toEqual([
      'systemctl --user show-environment',
      'systemctl --user daemon-reload',
      'systemctl --user enable tuinnel-plus.service',
      'systemctl --user restart tuinnel-plus.service',
    ]);
    // The token file exists before the unit that points at it.
    expect(calls.indexOf(`write ${ENV_FILE}`)).toBeLessThan(calls.indexOf(`write ${UNIT}`));
    expect(calls).not.toContain(ENABLE_LINGER);
  });

  test('reports replacing an existing unit', async () => {
    const { deps, files } = fakeDeps({ [LINGER]: { code: 0, stdout: 'yes' } });
    files.set(UNIT, '[Service]\nExecStart=/usr/bin/env tuinnel-plus serve\n');
    const r = await installService(opts, deps);
    expect(r.replaced).toBe(true);
    expect(files.get(UNIT)).toStartWith('# Written by tuinnel-plus service install.');
  });

  test('fails clearly without a systemd user instance and writes nothing', async () => {
    const { deps, files } = fakeDeps({
      'systemctl --user show-environment': { code: 1, stdout: 'Failed to connect to bus: No medium found' },
    });
    await expect(installService(opts, deps)).rejects.toThrow(/systemd user instance/);
    expect(files.size).toBe(0);
  });

  test('surfaces a failed restart', async () => {
    const { deps } = fakeDeps({ 'systemctl --user restart tuinnel-plus.service': { code: 1, stdout: 'boom' } });
    await expect(installService(opts, deps)).rejects.toThrow(/boom/);
  });

  test('systemd 239 → no append logging, logFile null', async () => {
    const { deps, files } = fakeDeps({
      [VERSION]: { code: 0, stdout: 'systemd 239 (239-78.el8)' },
      [LINGER]: { code: 0, stdout: 'yes' },
    });
    const r = await installService(opts, deps);
    expect(r.logFile).toBeNull();
    expect(files.get(UNIT)).not.toContain('StandardOutput');
  });

  test('lingering off but loginctl may enable it → "enabled"', async () => {
    const { deps, calls } = fakeDeps({ [LINGER]: { code: 0, stdout: 'no' } });
    const r = await installService(opts, deps);
    expect(r.linger).toBe('enabled');
    expect(calls).toContain(ENABLE_LINGER);
  });

  test('lingering off and refused → "needs-sudo"', async () => {
    const { deps } = fakeDeps({
      [LINGER]: { code: 0, stdout: 'no' },
      [ENABLE_LINGER]: { code: 1, stdout: 'Interactive authentication required.' },
    });
    const r = await installService(opts, deps);
    expect(r.linger).toBe('needs-sudo');
  });
});

describe('uninstallService', () => {
  test('disables, removes unit and env file, reloads, reports linger', async () => {
    const { deps, calls, files } = fakeDeps({ [LINGER]: { code: 0, stdout: 'yes' } });
    files.set(UNIT, 'x');
    files.set(ENV_FILE, 'y');
    const r = await uninstallService(ENV_FILE, deps);
    expect(r).toEqual({ removed: true, lingerOn: true });
    expect(files.size).toBe(0);
    expect(calls).toContain('systemctl --user disable --now tuinnel-plus.service');
    expect(calls.indexOf('systemctl --user daemon-reload')).toBeGreaterThan(calls.indexOf(`rm ${UNIT}`));
  });

  test('nothing installed → removed false', async () => {
    const { deps } = fakeDeps({ [LINGER]: { code: 0, stdout: 'no' } });
    expect(await uninstallService(ENV_FILE, deps)).toEqual({ removed: false, lingerOn: false });
  });
});

describe('serviceStatus', () => {
  const SHOW = 'systemctl --user show tuinnel-plus.service -p ActiveState -p MainPID';

  test('running', async () => {
    const { deps, files } = fakeDeps({
      [SHOW]: { code: 0, stdout: 'ActiveState=active\nMainPID=1234\n' },
      [LINGER]: { code: 0, stdout: 'yes' },
    });
    files.set(UNIT, 'x');
    expect(await serviceStatus(deps)).toEqual({ installed: true, active: true, pid: 1234, linger: true });
  });

  test('stopped: MainPID 0 → pid null', async () => {
    const { deps } = fakeDeps({
      [SHOW]: { code: 0, stdout: 'ActiveState=inactive\nMainPID=0\n' },
      [LINGER]: { code: 0, stdout: 'no' },
    });
    expect(await serviceStatus(deps)).toEqual({ installed: false, active: false, pid: null, linger: false });
  });
});
