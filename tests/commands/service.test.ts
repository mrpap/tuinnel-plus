import { describe, test, expect } from 'bun:test';
import { platformService, linuxInstallMessages, linuxUninstallMessages } from '../../src/commands/service.js';

const DASH = 'The service starts at boot and restarts if it crashes. Dashboard: http://127.0.0.1:8484';
const UNIT = '/home/me/.config/systemd/user/tuinnel-plus.service';
const base = { unitPath: UNIT, replaced: false, linger: 'on' as const, logFile: '/home/me/.tuinnel/logs/daemon.log', running: true };

describe('platformService', () => {
  test('launchd on macOS, systemd on Linux, nothing elsewhere', () => {
    expect(platformService('darwin')).toBe('launchd');
    expect(platformService('linux')).toBe('systemd');
    expect(platformService('win32')).toBeNull();
  });
});

describe('linuxInstallMessages', () => {
  test('a plain install', () => {
    expect(linuxInstallMessages(base, 'me', DASH)).toEqual([
      { level: 'success', text: `Installed systemd user service: ${UNIT}` },
      { level: 'info', text: DASH },
    ]);
  });

  test('says when it replaced a unit', () => {
    expect(linuxInstallMessages({ ...base, replaced: true }, 'me', DASH)).toContainEqual(
      { level: 'info', text: `Replaced the existing unit at ${UNIT}.` },
    );
  });

  test('says when it turned lingering on', () => {
    expect(linuxInstallMessages({ ...base, linger: 'enabled' }, 'me', DASH)).toContainEqual(
      { level: 'info', text: 'Enabled lingering for me, so the service starts at boot without a login.' },
    );
  });

  test('gives the sudo command when lingering stays off', () => {
    expect(linuxInstallMessages({ ...base, linger: 'needs-sudo' }, 'me', DASH)).toContainEqual({
      level: 'warn',
      text: 'Lingering is off, so the service only runs while you are logged in. To start it at boot, run:\n  sudo loginctl enable-linger me',
    });
  });

  test('says so when the service did not stay running', () => {
    const msgs = linuxInstallMessages({ ...base, running: false }, 'me', DASH);
    expect(msgs[0]).toEqual({ level: 'warn', text: `Installed systemd user service: ${UNIT}, but it did not stay running.` });
    expect(msgs).toContainEqual({
      level: 'warn',
      text: 'If tuinnel-plus is already running outside the service (for example started by the terminal dashboard), stop that process and run `tuinnel-plus service install` again. Details: `tuinnel-plus service status` and /home/me/.tuinnel/logs/daemon.log',
    });
    expect(msgs).not.toContainEqual({ level: 'info', text: DASH });
  });

  test('names the process to stop when one is running outside the service', () => {
    expect(linuxInstallMessages({ ...base, running: false }, 'me', DASH, 4242)).toContainEqual({
      level: 'warn',
      text: 'tuinnel-plus is already running outside the service (pid 4242). Stop it with `kill 4242`, then run `tuinnel-plus service install` again.',
    });
  });

  test('points at the journal on old systemd', () => {
    expect(linuxInstallMessages({ ...base, logFile: null }, 'me', DASH)).toContainEqual(
      { level: 'info', text: 'Logs: journalctl --user -u tuinnel-plus' },
    );
  });
});

describe('linuxUninstallMessages', () => {
  test('removed, lingering still on → mentions how to turn it off', () => {
    expect(linuxUninstallMessages({ removed: true, lingerOn: true }, 'me', UNIT)).toEqual([
      { level: 'success', text: `Removed systemd user service (${UNIT}). Running tunnels stopped with the service.` },
      { level: 'info', text: 'Lingering is still on for me. If nothing else needs it: sudo loginctl disable-linger me' },
    ]);
  });

  test('nothing installed → no lingering hint', () => {
    expect(linuxUninstallMessages({ removed: false, lingerOn: true }, 'me', UNIT)).toEqual([
      { level: 'info', text: 'Service not installed.' },
    ]);
  });
});
