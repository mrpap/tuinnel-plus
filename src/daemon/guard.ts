import { timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';
import type { Ctx } from './router.js';
import type { SessionStore } from './auth.js';

export const SESSION_COOKIE = 'tp_session';
const SESSION_MAX_AGE_S = 7 * 24 * 3600;

/**
 * Requests through the self-expose tunnel reach the daemon from cloudflared on
 * 127.0.0.1, so the loopback address proves nothing. Cloudflare always adds
 * this header to tunneled requests.
 */
export function isTunneled(req: IncomingMessage): boolean {
  return 'cf-connecting-ip' in req.headers;
}

/**
 * Rate-limit key: the real client IP behind the tunnel, else the socket peer.
 * The header is only believed from the local cloudflared; anyone else could
 * send a fresh one per attempt to dodge the limit.
 */
export function clientKey(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  const tunneledIp = Array.isArray(cf) ? cf[0] : cf;
  if (tunneledIp && isLoopbackPeer(req)) return tunneledIp;
  return req.socket.remoteAddress ?? 'unknown';
}

export function isSecure(req: IncomingMessage): boolean {
  return isTunneled(req) || req.headers['x-forwarded-proto'] === 'https';
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(id: string, req: IncomingMessage): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_S}${isSecure(req) ? '; Secure' : ''}`;
}

export function clearedSessionCookie(req: IncomingMessage): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isSecure(req) ? '; Secure' : ''}`;
}

export function sessionId(req: IncomingMessage): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Two trust lanes into one API: local clients present the localToken from the
 * 0600 daemon.json as a bearer token; browsers present a session cookie.
 * Cookie-lane writes must be JSON and same-origin (CSRF defence).
 */
export function createGuard(opts: {
  localToken: string;
  sessions: SessionStore;
  /** Host values the daemon answers to; see isSameOriginJson. */
  ownHosts?: () => string[];
}): (ctx: Ctx) => boolean {
  return ({ req }) => {
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (auth) return safeEqual(auth[1], opts.localToken);

    const sid = sessionId(req);
    if (!sid || !opts.sessions.valid(sid)) return false;

    return isSameOriginJson(req, opts.ownHosts?.() ?? []);
  };
}

/**
 * CSRF defence for browser writes: JSON (which forces a CORS preflight a
 * cross-site page can't pass) and, when an Origin is sent, one of our own
 * hosts. Through the self-expose tunnel the Host header is cloudflared's local
 * target while the Origin is the public hostname, so `ownHosts` (the daemon's
 * allowed hosts) is accepted as well as the request's own Host.
 * GET/HEAD always pass.
 */
export function isSameOriginJson(req: IncomingMessage, ownHosts: string[] = []): boolean {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return true;
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const host = new URL(origin).host;
      if (host !== req.headers.host && !ownHosts.includes(host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The TCP peer is this machine (the Host header alone can be spoofed from the LAN). */
export function isLoopbackPeer(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
