import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LAUNCHD_LABEL, plistPath, buildPlist, serviceEnv, installService, uninstallService, serviceStatus,
  defaultDeps, type LaunchdDeps,
} from '../../src/service/launchd.js';

const opts = {
  programArgs: ['/usr/local/bin/node', '/opt/tp/dist/index.js', 'serve'],
  env: { TUINNEL_HOME: '/Users/me/.tuinnel-plus', PATH: '/usr/bin:/bin' },
  logFile: '/Users/me/.tuinnel-plus/logs/daemon.log',
};

function fakeDeps(over: Partial<LaunchdDeps> = {}) {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const deps: LaunchdDeps = {
    exec: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '' }; },
    writeFile: (p, data) => { calls.push(`write ${p}`); files.set(p, data); },
    removeFile: (p) => { calls.push(`rm ${p}`); files.delete(p); },
    exists: (p) => files.has(p),
    mkdir: () => {},
    uid: 501,
    home: '/Users/me',
    ...over,
  };
  return { deps, calls, files };
}

describe('launchd plist', () => {
  test('label and path', () => {
    expect(LAUNCHD_LABEL).toBe('io.github.mrpap.tuinnel-plus');
    expect(plistPath('/Users/me')).toBe('/Users/me/Library/LaunchAgents/io.github.mrpap.tuinnel-plus.plist');
  });

  test('plist contains label, RunAtLoad, KeepAlive, args, TUINNEL_HOME, log paths', () => {
    const xml = buildPlist(opts);
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<key>Label</key>\n  <string>io.github.mrpap.tuinnel-plus</string>');
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(xml).toContain('<key>KeepAlive</key>\n  <true/>');
    // Background would throttle CPU/IO for cloudflared, which serves live sites.
    expect(xml).toContain('<key>ProcessType</key>\n  <string>Standard</string>');
    for (const a of opts.programArgs) expect(xml).toContain(`<string>${a}</string>`);
    expect(xml).toContain('<key>TUINNEL_HOME</key>\n    <string>/Users/me/.tuinnel-plus</string>');
    expect(xml).toContain('<key>StandardOutPath</key>\n  <string>/Users/me/.tuinnel-plus/logs/daemon.log</string>');
    expect(xml).toContain('<key>StandardErrorPath</key>\n  <string>/Users/me/.tuinnel-plus/logs/daemon.log</string>');
  });

  test('plist escapes & < > in paths', () => {
    const xml = buildPlist({ ...opts, programArgs: ['/a&b/<c>/node'] });
    expect(xml).toContain('<string>/a&amp;b/&lt;c&gt;/node</string>');
  });

  test('the plist is written owner-only, since it can hold an API token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-plist-'));
    try {
      const path = join(dir, 'agent.plist');
      writeFileSync(path, 'old', { mode: 0o644 });
      defaultDeps.writeFile(path, 'new');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('serviceEnv keeps TUINNEL_CLOUDFLARED so the service uses the same cloudflared', () => {
    expect(serviceEnv({ PATH: '/p', TUINNEL_CLOUDFLARED: '/opt/homebrew/bin/cloudflared' }))
      .toEqual({ PATH: '/p', TUINNEL_CLOUDFLARED: '/opt/homebrew/bin/cloudflared' });
  });

  test('serviceEnv keeps TUINNEL_HOME and PATH, tokens only if set', () => {
    expect(serviceEnv({ TUINNEL_HOME: '/h', PATH: '/p', HOME: '/x' })).toEqual({ TUINNEL_HOME: '/h', PATH: '/p' });
    expect(serviceEnv({ PATH: '/p', CLOUDFLARE_API_TOKEN: 't' })).toEqual({ PATH: '/p', CLOUDFLARE_API_TOKEN: 't' });
  });
});

describe('launchd install/uninstall/status', () => {
  test('install writes plist then bootouts then bootstraps', async () => {
    const { deps, calls, files } = fakeDeps();
    await installService(opts, deps);
    const plist = '/Users/me/Library/LaunchAgents/io.github.mrpap.tuinnel-plus.plist';
    expect(calls).toEqual([
      `write ${plist}`,
      'launchctl bootout gui/501/io.github.mrpap.tuinnel-plus',
      `launchctl bootstrap gui/501 ${plist}`,
    ]);
    expect(files.get(plist)).toContain('io.github.mrpap.tuinnel-plus');
  });

  test('install fails loudly when bootstrap fails', async () => {
    const { deps } = fakeDeps({
      exec: async (_c, args) => (args[0] === 'bootstrap' ? { code: 5, stdout: 'Bootstrap failed: 5: Input/output error' } : { code: 0, stdout: '' }),
    });
    await expect(installService(opts, deps)).rejects.toThrow('Bootstrap failed');
  });

  test('uninstall bootouts then removes the plist', async () => {
    const { deps, calls, files } = fakeDeps();
    const plist = '/Users/me/Library/LaunchAgents/io.github.mrpap.tuinnel-plus.plist';
    files.set(plist, 'x');
    await uninstallService(deps);
    expect(calls).toEqual(['launchctl bootout gui/501/io.github.mrpap.tuinnel-plus', `rm ${plist}`]);
  });

  test('status parses pid from launchctl print', async () => {
    const { deps, files } = fakeDeps({
      exec: async () => ({ code: 0, stdout: 'gui/501/io.github.mrpap.tuinnel-plus = {\n\tstate = running\n\tpid = 4321\n}' }),
    });
    files.set('/Users/me/Library/LaunchAgents/io.github.mrpap.tuinnel-plus.plist', 'x');
    expect(await serviceStatus(deps)).toEqual({ installed: true, loaded: true, pid: 4321 });
  });

  test('status loaded without pid when not running', async () => {
    const { deps, files } = fakeDeps({ exec: async () => ({ code: 0, stdout: 'state = not running' }) });
    files.set('/Users/me/Library/LaunchAgents/io.github.mrpap.tuinnel-plus.plist', 'x');
    expect(await serviceStatus(deps)).toEqual({ installed: true, loaded: true, pid: null });
  });

  test('status not installed when plist missing', async () => {
    const { deps } = fakeDeps({ exec: async () => ({ code: 113, stdout: 'Could not find service' }) });
    expect(await serviceStatus(deps)).toEqual({ installed: false, loaded: false, pid: null });
  });
});
