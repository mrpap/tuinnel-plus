import { z } from 'zod';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../auth.js';
import { clearedSessionCookie, clientKey, isLoopbackPeer, isTunneled, sessionCookie, sessionId } from '../guard.js';
import { HttpError, PUBLIC_ROUTES, sendJson, type DaemonDeps } from '../server.js';
import type { Router } from '../router.js';
import { webSettings } from '../../config/web.js';

const PasswordBody = z.object({ password: z.string() });

export function registerAuthRoutes(router: Router, deps: DaemonDeps): void {
  const auth = () => {
    if (!deps.auth) throw new HttpError(404, 'Not found');
    return deps.auth;
  };
  const passwordHash = () => auth().store.read()?.web?.passwordHash ?? null;

  for (const r of ['GET /api/auth/status', 'POST /api/auth/login', 'POST /api/auth/setup', 'POST /api/auth/logout']) {
    PUBLIC_ROUTES.add(r);
  }

  router.add('GET', '/api/auth/status', async (ctx) => {
    const sid = sessionId(ctx.req);
    sendJson(ctx.res, 200, {
      authenticated: sid !== null && auth().sessions.valid(sid),
      needsPasswordSetup: passwordHash() === null,
      // Public so the sign-in page can already use the chosen colour
      accentHue: webSettings(auth().store.read()).accentHue,
    });
  });

  router.add('POST', '/api/auth/setup', async ({ req, res, body }) => {
    const { store, sessions } = auth();
    if (isTunneled(req) || !isLoopbackPeer(req)) {
      throw new HttpError(403, 'Set the first password from the machine running tuinnel-plus.');
    }
    if (passwordHash() !== null) throw new HttpError(409, 'A password is already set.');
    const { password } = PasswordBody.parse(await body());
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    const config = store.read() ?? { version: 1 as const, tunnels: {} };
    config.web = { ...config.web, passwordHash: hashPassword(password) };
    store.write(config);
    res.setHeader('Set-Cookie', sessionCookie(sessions.create(), req));
    sendJson(res, 200, { ok: true });
  });

  router.add('POST', '/api/auth/login', async ({ req, res, body }) => {
    const { sessions, limiter } = auth();
    const key = clientKey(req);
    if (limiter.blocked(key)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const { password } = PasswordBody.parse(await body());
    const hash = passwordHash();
    if (!hash || !verifyPassword(password, hash)) {
      limiter.fail(key);
      throw new HttpError(401, 'Invalid password');
    }
    limiter.reset(key);
    res.setHeader('Set-Cookie', sessionCookie(sessions.create(), req));
    sendJson(res, 200, { ok: true });
  });

  router.add('POST', '/api/auth/logout', ({ req, res }) => {
    const sid = sessionId(req);
    if (sid) auth().sessions.revoke(sid);
    res.setHeader('Set-Cookie', clearedSessionCookie(req));
    sendJson(res, 200, { ok: true });
  });
}
