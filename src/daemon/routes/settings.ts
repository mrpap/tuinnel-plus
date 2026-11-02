import { z } from 'zod';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../auth.js';
import { sessionCookie } from '../guard.js';
import { HttpError, sendJson, type DaemonDeps } from '../server.js';
import type { Router } from '../router.js';
import { webSettings } from '../../config/web.js';
import { WebConfigSchema } from '../../config/schema.js';

const SelfExposeBody = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(true), subdomain: z.string().min(1), zone: z.string().min(1) }),
  z.object({ enabled: z.literal(false) }),
]);

const PasswordChangeBody = z.object({ current: z.string(), next: z.string() });

const AppearanceBody = z.object({ accentHue: WebConfigSchema.shape.accentHue.unwrap() });

export function registerSettingsRoutes(router: Router, deps: DaemonDeps): void {
  const selfExpose = () => {
    if (!deps.selfExpose) throw new HttpError(404, 'Not found');
    return deps.selfExpose;
  };
  const auth = () => {
    if (!deps.auth) throw new HttpError(404, 'Not found');
    return deps.auth;
  };

  router.add('GET', '/api/settings', ({ res }) => {
    const listen = deps.listenInfo?.() ?? { port: null, host: null };
    sendJson(res, 200, {
      selfExpose: selfExpose().status(),
      accentHue: webSettings(deps.auth?.store.read() ?? null).accentHue,
      ...listen,
    });
  });

  router.add('PUT', '/api/settings/appearance', async ({ res, body }) => {
    const { accentHue } = AppearanceBody.parse(await body());
    const { store } = auth();
    const config = store.read() ?? { version: 1 as const, tunnels: {} };
    store.write({ ...config, web: { ...config.web, accentHue } });
    sendJson(res, 200, { accentHue });
  });

  router.add('PUT', '/api/settings/self-expose', async ({ res, body }) => {
    const input = SelfExposeBody.parse(await body());
    if (input.enabled) await selfExpose().enable(input.subdomain.trim().toLowerCase(), input.zone.trim());
    else await selfExpose().disable();
    sendJson(res, 200, selfExpose().status());
  });

  router.add('POST', '/api/settings/password', async ({ req, res, body }) => {
    const { store, sessions } = auth();
    const { current, next } = PasswordChangeBody.parse(await body());
    const config = store.read();
    const hash = config?.web?.passwordHash;
    if (!config || !hash || !verifyPassword(current, hash)) throw new HttpError(403, 'Current password is incorrect.');
    if (next.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    config.web = { ...config.web, passwordHash: hashPassword(next) };
    store.write(config);
    sessions.revokeAll();
    res.setHeader('Set-Cookie', sessionCookie(sessions.create(), req));
    sendJson(res, 200, { ok: true });
  });

  // `tuinnel-plus password set` calls this after writing a new hash to config.
  router.add('POST', '/api/settings/password/reload', ({ req, res }) => {
    if (!/^Bearer /.test(req.headers.authorization ?? '')) throw new HttpError(403, 'Local clients only.');
    auth().sessions.revokeAll();
    res.writeHead(204);
    res.end();
  });
}
