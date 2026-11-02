import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureDaemon, findDaemon } from '../../src/client/ensure-daemon.js';
import { writeDescriptor, type DaemonDescriptor } from '../../src/daemon/descriptor.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tp-ensure-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const D: DaemonDescriptor = { pid: 1, host: '127.0.0.1', port: 9, localToken: 'x', version: '0.1.0', startedAt: 0 };

describe('ensureDaemon', () => {
  test('returns existing healthy daemon without spawning', async () => {
    writeDescriptor(dir, D);
    let spawned = 0;
    const d = await ensureDaemon({ stateDir: dir, spawnDaemon: () => { spawned++; }, probe: async () => true });
    expect(d).toEqual(D);
    expect(spawned).toBe(0);
  });

  test('stale descriptor (probe false) triggers spawn and waits', async () => {
    writeDescriptor(dir, { ...D, pid: 1 });
    let healthy = false;
    const d = await ensureDaemon({
      stateDir: dir,
      spawnDaemon: () => {
        setTimeout(() => { writeDescriptor(dir, { ...D, pid: 2 }); healthy = true; }, 150);
      },
      probe: async (desc) => healthy && desc.pid === 2,
    });
    expect(d.pid).toBe(2);
  });

  test('times out with log path in message', async () => {
    await expect(ensureDaemon({ stateDir: dir, timeoutMs: 200, spawnDaemon: () => {}, probe: async () => false }))
      .rejects.toThrow(`Background service failed to start — see ${join(dir, 'logs', 'daemon.log')}`);
  });

  test('findDaemon is null without a descriptor', async () => {
    expect(await findDaemon(dir)).toBeNull();
  });

  test('findDaemon probes /api/health on the descriptor address', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) =>
      new URL(req.url).pathname === '/api/health' ? Response.json({ ok: true, pid: 42 }) : new Response('no', { status: 404 }) });
    try {
      writeDescriptor(dir, { ...D, port: server.port });
      expect((await findDaemon(dir))?.port).toBe(server.port);
    } finally {
      server.stop(true);
    }
  });
});
