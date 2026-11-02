import { z } from 'zod';
import { TunnelConfigSchema } from '../../config/schema.js';
import { PartialDeleteError } from '../../services/tunnel-service.js';
import { validateSubdomain } from '../../utils/validation.js';
import { toWireTunnel, type WireTunnel } from '../wire.js';
import { HttpError, sendJson, type DaemonDeps } from '../server.js';
import type { Router } from '../router.js';

const SYSTEM_TUNNEL_MESSAGE = 'This tunnel serves the admin UI; disable self-expose in Settings instead.';

const port = z.number().int().min(1).max(65535);
const subdomain = z.string().refine((s) => validateSubdomain(s, false) !== null, {
  message: 'Must be lowercase alphanumeric with hyphens, cannot start or end with a hyphen, max 63 characters',
});
const protocol = TunnelConfigSchema.shape.protocol.removeDefault().optional();

const CreateBody = z.object({
  port,
  subdomain,
  zone: z.string().min(1),
  protocol,
  start: z.boolean().optional(),
});

const UpdateBody = z.object({
  port: port.optional(),
  subdomain: subdomain.optional(),
  zone: z.string().min(1).optional(),
  protocol,
});

export function registerTunnelRoutes(router: Router, deps: DaemonDeps): void {
  const { service } = deps;

  const wire = (name: string): WireTunnel => {
    const t = service.get(name);
    if (!t) throw new Error(`Tunnel "${name}" not found`);
    return toWireTunnel(t, deps.isSystemTunnel(name));
  };

  const refuseSystem = (name: string) => {
    if (deps.isSystemTunnel(name)) throw new HttpError(409, SYSTEM_TUNNEL_MESSAGE);
  };

  router.add('GET', '/api/tunnels', ({ res }) => {
    const list = [...service.getAll().values()]
      .map((t) => toWireTunnel(t, deps.isSystemTunnel(t.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, list);
  });

  router.add('GET', '/api/tunnels/:name', ({ res, params }) => {
    sendJson(res, 200, wire(params.name));
  });

  router.add('POST', '/api/tunnels', async ({ res, body }) => {
    const { start, ...opts } = CreateBody.parse(await body());
    const name = await service.create({ ...opts, subdomain: opts.subdomain.toLowerCase() });
    if (start) await service.start(name);
    sendJson(res, 201, wire(name));
  });

  router.add('PATCH', '/api/tunnels/:name', async ({ res, params, body }) => {
    refuseSystem(params.name);
    const changes = UpdateBody.parse(await body());
    if (changes.subdomain) changes.subdomain = changes.subdomain.toLowerCase();
    await service.update(params.name, changes);
    sendJson(res, 200, wire(changes.subdomain ?? params.name));
  });

  router.add('DELETE', '/api/tunnels/:name', async ({ res, params }) => {
    refuseSystem(params.name);
    try {
      await service.delete(params.name);
      sendJson(res, 200, { removed: true, warnings: [] });
    } catch (err) {
      if (err instanceof PartialDeleteError) {
        sendJson(res, 200, { removed: true, warnings: err.warnings });
        return;
      }
      throw err;
    }
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    router.add('POST', `/api/tunnels/:name/${action}`, async ({ res, params }) => {
      if (action === 'stop') refuseSystem(params.name);
      await service[action](params.name);
      sendJson(res, 200, wire(params.name));
    });
  }
}
