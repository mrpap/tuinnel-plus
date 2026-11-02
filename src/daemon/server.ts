import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { ZodError } from 'zod';
import { Router, type Ctx } from './router.js';
import { registerTunnelRoutes } from './routes/tunnels.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { serveStatic } from './static.js';
import { isSameOriginJson } from './guard.js';
import type { TunnelBackend } from '../services/backend.js';
import type { SseHub } from './sse.js';
import type { TunnelMetrics } from '../types.js';
import type { PurgePlan, PurgeResult } from '../services/purge.js';
import type { ConfigStore } from '../config/store.js';
import type { RateLimiter, SessionStore } from './auth.js';
import type { SelfExpose } from './self-expose.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface DaemonDeps {
  service: TunnelBackend;
  /** True when the request carries valid credentials (bearer localToken or session cookie). */
  guard: (ctx: Ctx) => Promise<boolean> | boolean;
  /** Host header values the daemon answers to (loopback + self-expose hostname). */
  allowedHosts: () => string[];
  /** True for the tunnel that serves the admin UI itself (self-expose). */
  isSystemTunnel: (name: string) => boolean;
  /** Live event feed for GET /api/events. */
  hub?: SseHub;
  zones?: () => Promise<Array<{ id: string; name: string }>>;
  /** Preview orphaned Cloudflare tunnels, then delete only the ids the user confirmed. */
  purge?: { preview: () => Promise<PurgePlan>; run: (ids: string[]) => Promise<PurgeResult> };
  /** Re-read token + config into the running service (after CLI `add` or onboarding). */
  reload?: () => Promise<void>;
  scrape?: (addr: string) => Promise<TunnelMetrics>;
  /** Password auth state for the browser lane. */
  auth?: { store: ConfigStore; sessions: SessionStore; limiter: RateLimiter };
  selfExpose?: SelfExpose;
  /** Address the daemon listens on (shown in Settings). */
  listenInfo?: () => { port: number; host: string };
  /** Directory holding the web UI (index.html, app.js, …). */
  assetsDir?: string;
  statusInfo?: () => { version: string; startedAt: number; selfExpose: { enabled: boolean; url: string | null } };
}

/** An error carrying the HTTP status it should be reported with. */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** Routes reachable without credentials, as "METHOD /pattern". */
export const PUBLIC_ROUTES = new Set<string>();

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

export function errorStatus(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof ZodError) return 400;
  const msg = err instanceof Error ? err.message : String(err);
  if (/^Tunnel ".*" not found$/.test(msg)) return 404;
  if (/^Tunnel ".*" (is )?already (exists|running)$/.test(msg)) return 409;
  if (/^Zone ".*" not found/.test(msg)) return 400;
  return 500;
}

function errorMessage(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return; // keep draining so the client sees our response, not a reset
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'Request body too large'));
      const text = Buffer.concat(chunks).toString('utf-8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createDaemonServer(deps: DaemonDeps): { server: Server; router: Router } {
  const router = new Router();
  registerMetaRoutes(router, deps);
  registerAuthRoutes(router, deps);
  registerSettingsRoutes(router, deps);
  registerTunnelRoutes(router, deps);
  router.add('GET', '/api/events', ({ res }) => {
    if (!deps.hub) throw new HttpError(404, 'Not found');
    deps.hub.attach(res);
  });

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!deps.allowedHosts().includes(host)) {
        return sendError(res, 421, 'Misdirected request');
      }

      const url = new URL(req.url ?? '/', `http://${host}`);
      const method = req.method ?? 'GET';

      // Everything outside /api/ is the public web UI shell.
      if (!url.pathname.startsWith('/api/')) {
        const served = deps.assetsDir && (method === 'GET' || method === 'HEAD')
          && serveStatic(url.pathname, res, deps.assetsDir);
        if (!served) sendError(res, 404, 'Not found');
        return;
      }
      const found = router.match(method, url.pathname);
      if (!found) return sendError(res, 404, 'Not found');

      let bodyPromise: Promise<unknown> | null = null;
      const ctx: Ctx = {
        req,
        res,
        url,
        params: found.params,
        body: () => (bodyPromise ??= readBody(req)),
      };

      if (PUBLIC_ROUTES.has(`${method} ${found.pattern}`)) {
        // Public auth routes skip the guard, so apply its CSRF check here.
        if (!isSameOriginJson(req, deps.allowedHosts())) return sendError(res, 403, 'Cross-site request refused');
      } else if (!(await deps.guard(ctx))) {
        return sendError(res, 401, 'Unauthorized');
      }

      await found.handler(ctx);
    } catch (err) {
      if (!res.headersSent) sendError(res, errorStatus(err), errorMessage(err));
      else res.end();
    }
  });

  return { server, router };
}
