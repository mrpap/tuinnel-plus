import { describe, test, expect } from 'bun:test';
import { checkCloudflared } from '../../src/commands/doctor.js';

const MANAGED = '/home/me/.tuinnel/bin/cloudflared';

function deps(opts: { env?: Record<string, string>; files?: string[] }) {
  return {
    env: opts.env ?? {},
    managedPath: MANAGED,
    exists: (p: string) => (opts.files ?? []).includes(p),
    version: (p: string) => (p === MANAGED ? '2026.10.3' : '2026.11.0'),
  };
}

describe('doctor: cloudflared check', () => {
  test('reports the binary set by TUINNEL_CLOUDFLARED, not whatever is on PATH', () => {
    const r = checkCloudflared(deps({ env: { TUINNEL_CLOUDFLARED: '/opt/homebrew/bin/cloudflared' }, files: ['/opt/homebrew/bin/cloudflared', MANAGED] }));
    expect(r).toEqual({ ok: true, detail: 'Version 2026.11.0 (/opt/homebrew/bin/cloudflared, from TUINNEL_CLOUDFLARED)' });
  });

  test('fails when TUINNEL_CLOUDFLARED points nowhere', () => {
    const r = checkCloudflared(deps({ env: { TUINNEL_CLOUDFLARED: '/nope/cloudflared' } }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('/nope/cloudflared');
  });

  test('otherwise reports the managed copy tuinnel-plus downloaded', () => {
    expect(checkCloudflared(deps({ files: [MANAGED] }))).toEqual({ ok: true, detail: 'Version 2026.10.3 (managed)' });
  });

  test('says it will be downloaded when there is none yet', () => {
    const r = checkCloudflared(deps({}));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('downloaded');
  });
});
