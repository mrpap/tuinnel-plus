import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  daemonPaths, writeDescriptor, readDescriptor, acquireLock, releaseLock, DaemonRunningError, isDaemonProcess, processCommand,
  type DaemonDescriptor,
} from '../../src/daemon/descriptor.js';

let dir: string;
beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), 'tp-desc-')), 'state'); });
afterEach(() => { rmSync(join(dir, '..'), { recursive: true, force: true }); });

const D: DaemonDescriptor = { pid: 123, host: '127.0.0.1', port: 8484, localToken: 'abc', version: '0.1.0', startedAt: 1 };

describe('daemon descriptor', () => {
  test('paths live in the state dir', () => {
    expect(daemonPaths(dir)).toEqual({
      descriptor: join(dir, 'daemon.json'),
      lock: join(dir, 'daemon.lock'),
      logDir: join(dir, 'logs'),
      logFile: join(dir, 'logs', 'daemon.log'),
    });
  });

  test('descriptor written 0600 and read back', () => {
    writeDescriptor(dir, D);
    expect(statSync(daemonPaths(dir).descriptor).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readDescriptor(dir)).toEqual(D);
  });

  test('missing descriptor reads as null', () => {
    expect(readDescriptor(dir)).toBeNull();
  });

  test('corrupt descriptor reads as null', () => {
    writeDescriptor(dir, D);
    writeFileSync(daemonPaths(dir).descriptor, '{nope');
    expect(readDescriptor(dir)).toBeNull();
  });

  test('second acquire with live holder throws DaemonRunningError', () => {
    acquireLock(dir, 111, () => true);
    expect(() => acquireLock(dir, 222, () => true)).toThrow(DaemonRunningError);
    expect(() => acquireLock(dir, 222, () => true)).toThrow('tuinnel-plus daemon already running (pid 111)');
  });

  test('stale lock (dead pid) is taken over', () => {
    acquireLock(dir, 111, () => true);
    acquireLock(dir, 222, () => false);
    expect(readFileSync(daemonPaths(dir).lock, 'utf-8').trim()).toBe('222');
  });

  test('release ignores files owned by another pid', () => {
    acquireLock(dir, 111, () => true);
    writeDescriptor(dir, { ...D, pid: 111 });
    releaseLock(dir, 222);
    expect(existsSync(daemonPaths(dir).lock)).toBe(true);
    expect(existsSync(daemonPaths(dir).descriptor)).toBe(true);
    releaseLock(dir, 111);
    expect(existsSync(daemonPaths(dir).lock)).toBe(false);
    expect(existsSync(daemonPaths(dir).descriptor)).toBe(false);
  });

  describe('lock holder identity (pid reuse after a crash)', () => {
    // The parent process (the shell or runner that started the tests) is a pid
    // that is certainly alive; its command line is supplied by the test.
    const alive = process.ppid;
    const as = (command: string | null) => () => command;

    test('a live pid that is not a tuinnel daemon does not hold the lock', () => {
      expect(isDaemonProcess(alive, as('/usr/sbin/cupsd -l'))).toBe(false);
      expect(isDaemonProcess(alive, as('node /srv/app/server.js serve'))).toBe(false);
    });

    test('a live tuinnel-plus serve process holds the lock', () => {
      expect(isDaemonProcess(alive, as('node /usr/local/bin/tuinnel-plus serve'))).toBe(true);
      expect(isDaemonProcess(alive, as('/usr/bin/node /opt/tp/dist/index.js serve'))).toBe(true);
    });

    test('a pid whose command line cannot be read still counts as held', () => {
      expect(isDaemonProcess(alive, as(null))).toBe(true);
    });

    test('a pid that no longer exists does not hold the lock', () => {
      const gone = spawnSync('true').pid;
      expect(isDaemonProcess(gone, as('tuinnel-plus serve'))).toBe(false);
    });

    test('a lock already held by this process counts as held', () => {
      expect(isDaemonProcess(process.pid)).toBe(true);
    });

    test('processCommand reads a real command line', () => {
      expect(processCommand(process.pid)).toContain('bun');
    });

    test('stale lock whose pid was reused by another process is taken over', () => {
      const reused = (pid: number) => isDaemonProcess(pid, as('/usr/sbin/cupsd -l'));
      acquireLock(dir, alive, reused);
      acquireLock(dir, 222, reused);
      expect(readFileSync(daemonPaths(dir).lock, 'utf-8').trim()).toBe('222');
    });
  });
});
