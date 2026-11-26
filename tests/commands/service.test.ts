import { describe, test, expect } from 'bun:test';
import { platformService, linuxInstallMessages } from '../../src/commands/service.js';

const DASH = 'The service starts at boot and restarts if it crashes. Dashboard: http://127.0.0.1:8484';
const UNIT = '/home/me/.config/systemd/user/tuinnel-plus.service';
const base = { unitPath: UNIT, replaced: false, linger: 'on' as const, logFile: '/home/me/.tuinnel/logs/daemon.log' };

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

  test('points at the journal on old systemd', () => {
    expect(linuxInstallMessages({ ...base, logFile: null }, 'me', DASH)).toContainEqual(
      { level: 'info', text: 'Logs: journalctl --user -u tuinnel-plus' },
    );
  });
});
