import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

const originalFetch = globalThis.fetch;

function cfSuccess<T>(result: T, opts: {
  result_info?: { page: number; per_page: number; count: number; total_count: number; total_pages: number };
} = {}) {
  return {
    success: true,
    errors: [],
    messages: [],
    result,
    ...(opts.result_info ? { result_info: opts.result_info } : {}),
  };
}

function cfError(code: number, message: string) {
  return { success: false, errors: [{ code, message }], messages: [], result: null };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ZONE = {
  id: 'zone-1',
  name: 'example.com',
  status: 'active',
  account: { id: 'acct-1', name: 'My Account' },
};

// Cloudflare tunnel ids are UUIDs; TunnelSchema validates this, so fixtures must comply.
const TUNNEL_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const CNAME = {
  id: 'dns-myapp',
  type: 'CNAME',
  name: 'myapp.example.com',
  content: `${TUNNEL_ID}.cfargotunnel.com`,
  proxied: true,
  ttl: 1,
};

const CF_TUNNEL = {
  id: TUNNEL_ID,
  name: 'tuinnel-myapp',
  status: 'inactive',
  created_at: '2026-01-01T00:00:00Z',
  connections: [],
};

interface FetchLog { method: string; url: string; }

/**
 * A mock CF backend covering the full delete flow. Records every DELETE.
 * `opts` lets individual tests make a specific step fail or return empty.
 */
function installFetch(opts: {
  log: FetchLog[];
  dnsList?: unknown[];        // records returned by listDnsRecords
  tunnelByName?: unknown[];   // records returned by getTunnelByName
  failDnsDelete?: boolean;
  failTunnelDelete?: boolean;
} = { log: [] }) {
  const dnsList = opts.dnsList ?? [CNAME];
  const tunnelByName = opts.tunnelByName ?? [CF_TUNNEL];

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    opts.log.push({ method, url });

    // discoverAccountId: GET /zones?per_page=1
    if (url.includes('/zones') && url.includes('per_page=1')) {
      return jsonResponse(cfSuccess([ZONE]));
    }
    // getAllZones: GET /zones (paginated)
    if (url.includes('/zones') && !url.includes('/dns_records') && !url.includes('per_page=1')) {
      return jsonResponse(cfSuccess([ZONE], {
        result_info: { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 },
      }));
    }
    // listDnsRecords: GET /zones/<id>/dns_records
    if (url.includes('/dns_records') && method === 'GET') {
      return jsonResponse(cfSuccess(dnsList, {
        result_info: { page: 1, per_page: 50, count: dnsList.length, total_count: dnsList.length, total_pages: 1 },
      }));
    }
    // deleteDnsRecord: DELETE /zones/<id>/dns_records/<id>
    if (url.includes('/dns_records/') && method === 'DELETE') {
      if (opts.failDnsDelete) return jsonResponse(cfError(1000, 'DNS delete failed'), 500);
      return jsonResponse(cfSuccess({ id: 'deleted' }));
    }
    // getTunnelByName: GET /accounts/<acct>/cfd_tunnel?name=...
    if (url.includes('/cfd_tunnel') && method === 'GET' && url.includes('name=')) {
      return jsonResponse(cfSuccess(tunnelByName));
    }
    // deleteTunnel: DELETE /accounts/<acct>/cfd_tunnel/<id>
    if (url.includes('/cfd_tunnel/') && method === 'DELETE') {
      if (opts.failTunnelDelete) return jsonResponse(cfError(1000, 'Tunnel delete failed'), 500);
      return jsonResponse(cfSuccess(CF_TUNNEL));
    }
    return jsonResponse(cfError(404, `Unhandled: ${method} ${url}`), 404);
  };
}

describe('deleteTunnelResources', () => {
  let deleteTunnelResources: typeof import('../../src/cloudflare/tunnel-manager.js').deleteTunnelResources;

  beforeEach(async () => {
    const tm = await import('../../src/cloudflare/tunnel-manager.js');
    deleteTunnelResources = tm.deleteTunnelResources;
    const api = await import('../../src/cloudflare/api.js');
    api.clearAccountIdCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('deletes the CNAME DNS record for the subdomain', async () => {
    const log: FetchLog[] = [];
    installFetch({ log });

    const result = await deleteTunnelResources(
      'myapp',
      { subdomain: 'myapp', zone: 'example.com' },
      'tok',
      TUNNEL_ID,
    );

    expect(result.dnsDeleted).toBe(true);
    expect(result.warnings).toEqual([]);
    const dnsDelete = log.find(c => c.method === 'DELETE' && c.url.includes('/dns_records/dns-myapp'));
    expect(dnsDelete).toBeDefined();
  });

  test('deletes the tunnel by name when no tunnelId is provided', async () => {
    const log: FetchLog[] = [];
    installFetch({ log });

    const result = await deleteTunnelResources(
      'myapp',
      { subdomain: 'myapp', zone: 'example.com' },
      'tok',
      null, // no stored tunnelId — must look it up by name
    );

    expect(result.tunnelDeleted).toBe(true);
    const lookedUpByName = log.find(c => c.method === 'GET' && c.url.includes('/cfd_tunnel') && c.url.includes('name='));
    expect(lookedUpByName).toBeDefined();
    const tunnelDelete = log.find(c => c.method === 'DELETE' && c.url.includes(`/cfd_tunnel/${TUNNEL_ID}`));
    expect(tunnelDelete).toBeDefined();
  });

  test('deletes both DNS and tunnel with no warnings on the happy path', async () => {
    const log: FetchLog[] = [];
    installFetch({ log });

    const result = await deleteTunnelResources(
      'myapp',
      { subdomain: 'myapp', zone: 'example.com' },
      'tok',
      TUNNEL_ID,
    );

    expect(result.dnsDeleted).toBe(true);
    expect(result.tunnelDeleted).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test('records a warning if DNS deletion fails but still deletes the tunnel', async () => {
    const log: FetchLog[] = [];
    installFetch({ log, failDnsDelete: true });

    const result = await deleteTunnelResources(
      'myapp',
      { subdomain: 'myapp', zone: 'example.com' },
      'tok',
      TUNNEL_ID,
    );

    expect(result.dnsDeleted).toBe(false);
    expect(result.tunnelDeleted).toBe(true);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('myapp.example.com');
  });
});
