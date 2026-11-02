import type { IncomingMessage, ServerResponse } from 'http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  url: URL;
  body(): Promise<unknown>;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: Handler;
}

/** Minimal method + path router. Pattern segments starting with `:` are params. */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, pattern, segments: split(pattern), handler });
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string>; pattern: string } | null {
    const parts = split(path);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) {
          try {
            params[seg.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            ok = false;
            break;
          }
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params, pattern: route.pattern };
    }
    return null;
  }
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}
