import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { clearAccountIdCache } from '../../src/cloudflare/api.js';
import { findOrphans, purgeOrphans } from '../../src/services/purge.js';
import { memStore, cfgWith } from './helpers.js';

const originalFetch = globalThis.fetch;
beforeEach(() => clearAccountIdCache());
afterEach(() => { globalThis.fetch = originalFetch; });

const ok = (result: unknown, paged = false) => new Response(JSON.stringify({
  success: true, errors: [], messages: [], result,
  ...(paged ? { result_info: { page: 1, per_page: 50, count: (result as unknown[]).length, total_count: (result as unknown[]).length, total_pages: 1 } } : {}),
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

const ZONE = { id: 'z1', name: 'example.com', status: 'active', account: { id: 'acct-1', name: 'A' } };
const tunnel = (id: string, name: string) => ({ id, name, status: 'inactive', created_at: '2026-01-01T00:00:00Z', connections: [] });
const T_A = tunnel('aaaaaaaa-bbbb-cccc-dddd-000000000001', 'tuinnel-a');
const T_B = tunnel('aaaaaaaa-bbbb-cccc-dddd-000000000002', 'tuinnel-b');
const T_OTHER = tunnel('aaaaaaaa-bbbb-cccc-dddd-000000000003', 'other');
const T_LIVE = { ...tunnel('aaaaaaaa-bbbb-cccc-dddd-000000000004', 'tuinnel-elsewhere'), status: 'healthy' };

function installFetch(deleted: string[]) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? 'GET';
    if (url.includes('/zones') && url.includes('per_page=1')) return ok([ZONE]);
    if (url.includes('/cfd_tunnel/') && method === 'DELETE') {
      deleted.push(url.split('/cfd_tunnel/')[1]);
      return ok(T_B);
    }
    if (url.includes('/cfd_tunnel')) return ok([T_A, T_B, T_OTHER, T_LIVE], true);
    return new Response('unhandled', { status: 404 });
  }) as typeof fetch;
}

describe('purge service', () => {
  test('findOrphans returns managed tunnels missing from config and dead pids', async () => {
    installFetch([]);
    const plan = await findOrphans('tok', memStore(cfgWith('a')), {
      readPids: () => ({ a: { pid: 1, startedAt: 0 }, ghost: { pid: 2, startedAt: 0 } }),
      isAlive: (pid) => pid === 1,
    });
    expect(plan.accountId).toBe('acct-1');
    expect(plan.orphaned.map((t) => t.name)).toEqual(['tuinnel-b']);
    expect(plan.stalePids).toEqual(['ghost']);
  });

  test('tunnels with live connections are never orphans: they run somewhere else', async () => {
    installFetch([]);
    const plan = await findOrphans('tok', memStore(cfgWith('a')), { readPids: () => ({}) });
    expect(plan.orphaned.map((t) => t.name)).not.toContain('tuinnel-elsewhere');
    expect(plan.active.map((t) => t.name)).toEqual(['tuinnel-elsewhere']);
  });

  test('purgeOrphans deletes orphans and cleans stale pids', async () => {
    const deleted: string[] = [];
    installFetch(deleted);
    let written: Record<string, unknown> | null = null;
    const result = await purgeOrphans(
      { accountId: 'acct-1', orphaned: [{ id: T_B.id, name: 'tuinnel-b', status: 'inactive' }], stalePids: ['ghost'] },
      'tok',
      {
        readPids: () => ({ a: { pid: 1, startedAt: 0 }, ghost: { pid: 2, startedAt: 0 } }),
        writePids: (p) => { written = p; },
      },
    );
    expect(deleted).toEqual([T_B.id]);
    expect(result).toEqual({ deleted: ['tuinnel-b'], failed: [], cleanedPids: 1 });
    expect(Object.keys(written!)).toEqual(['a']);
  });
});
