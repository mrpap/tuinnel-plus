import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import {
  daemonPaths, writeDescriptor, readDescriptor, acquireLock, releaseLock, DaemonRunningError, isDaemonProcess,
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
    let child: ChildProcess | null = null;
    afterEach(() => { child?.kill(); child = null; });

    // `; true` keeps sh alive (no exec), so ps shows these argv words. On Linux
    // spawn returns before the exec, so wait until ps shows the new command line.
    const live = (...argv: string[]) => {
      child = spawn('/bin/sh', ['-c', 'sleep 5; true', ...argv], { stdio: 'ignore' });
      const pid = child.pid!;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const cmd = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).stdout;
        if (cmd.includes('sleep 5')) break;
      }
      return pid;
    };

    test('a live pid that is not a tuinnel daemon does not hold the lock', () => {
      expect(isDaemonProcess(live('unrelated', 'app'))).toBe(false);
    });

    test('a live tuinnel-plus serve process holds the lock', () => {
      expect(isDaemonProcess(live('tuinnel-plus', 'serve'))).toBe(true);
    });

    test('a lock already held by this process counts as held', () => {
      expect(isDaemonProcess(process.pid)).toBe(true);
    });

    test('stale lock whose pid was reused by another process is taken over', () => {
      acquireLock(dir, live('reused', 'pid'));
      acquireLock(dir, 222);
      expect(readFileSync(daemonPaths(dir).lock, 'utf-8').trim()).toBe('222');
    });
  });
});
