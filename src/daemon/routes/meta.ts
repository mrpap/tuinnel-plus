import { z } from 'zod';
import { HttpError, PUBLIC_ROUTES, sendJson, type DaemonDeps } from '../server.js';
import { toWireEvent } from '../wire.js';
import type { Router } from '../router.js';

const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 1000;

const PurgeBody = z.object({ ids: z.array(z.string()) });

function need<T>(dep: T | undefined): T {
  if (dep === undefined) throw new HttpError(404, 'Not found');
  return dep;
}

export function registerMetaRoutes(router: Router, deps: DaemonDeps): void {
  const { service } = deps;

  PUBLIC_ROUTES.add('GET /api/health');
  router.add('GET', '/api/health', ({ res }) => {
    sendJson(res, 200, { ok: true, pid: process.pid });
  });

  router.add('GET', '/api/status', ({ res }) => {
    const info = need(deps.statusInfo)();
    const tunnels = [...service.getAll().values()];
    sendJson(res, 200, {
      version: info.version,
      uptimeMs: Date.now() - info.startedAt,
      counts: {
        total: tunnels.length,
        running: tunnels.filter((t) => t.state !== 'stopped' && t.state !== 'error').length,
        error: tunnels.filter((t) => t.state === 'error').length,
      },
      selfExpose: info.selfExpose,
    });
  });

  router.add('GET', '/api/zones', async ({ res }) => {
    sendJson(res, 200, await need(deps.zones)());
  });

  router.add('GET', '/api/tunnels/:name/logs', ({ res, params, url }) => {
    const t = service.get(params.name);
    if (!t) throw new Error(`Tunnel "${params.name}" not found`);
    const requested = parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_LOG_LIMIT)
      : DEFAULT_LOG_LIMIT;
    sendJson(res, 200, t.connections.slice(-limit).map(toWireEvent));
  });

  router.add('GET', '/api/tunnels/:name/metrics', async ({ res, params }) => {
    const t = service.get(params.name);
    if (!t) throw new Error(`Tunnel "${params.name}" not found`);
    if (t.metricsPort === null) {
      res.writeHead(204);
      res.end();
      return;
    }
    let metrics;
    try {
      metrics = await need(deps.scrape)(`127.0.0.1:${t.metricsPort}`);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
    sendJson(res, 200, { ...metrics, lastScrapedAt: metrics.lastScrapedAt.toISOString() });
  });

  router.add('GET', '/api/purge', async ({ res }) => {
    sendJson(res, 200, await need(deps.purge).preview());
  });

  router.add('POST', '/api/purge', async ({ res, body }) => {
    const { ids } = PurgeBody.parse(await body());
    sendJson(res, 200, await need(deps.purge).run(ids));
  });

  router.add('POST', '/api/reload', async ({ res }) => {
    await need(deps.reload)();
    res.writeHead(204);
    res.end();
  });
}
