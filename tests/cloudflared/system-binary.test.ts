import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureBinary } from '../../src/cloudflared/binary.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  delete process.env.TUINNEL_CLOUDFLARED;
  globalThis.fetch = realFetch;
});

describe('TUINNEL_CLOUDFLARED', () => {
  test('uses the given cloudflared instead of downloading one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-cfd-'));
    try {
      const bin = join(dir, 'cloudflared');
      writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
      process.env.TUINNEL_CLOUDFLARED = bin;
      let downloads = 0;
      globalThis.fetch = (async () => { downloads++; return new Response('', { status: 500 }); }) as unknown as typeof fetch;
      expect(await ensureBinary()).toBe(bin);
      expect(downloads).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a path that does not exist is an error, not a silent download', async () => {
    process.env.TUINNEL_CLOUDFLARED = '/nonexistent/cloudflared';
    await expect(ensureBinary()).rejects.toThrow('TUINNEL_CLOUDFLARED');
  });
});
