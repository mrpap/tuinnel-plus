import { existsSync, readFileSync, statSync } from 'fs';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import type { ServerResponse } from 'http';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Locate the web UI assets: `dist/web` next to the bundled `dist/index.js`,
 * or `src/web` when running from source (this file is `src/daemon/static.ts`).
 */
export function resolveAssetsDir(): string {
  const candidates = [
    fileURLToPath(new URL('./web', import.meta.url)),
    fileURLToPath(new URL('../web', import.meta.url)),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? candidates[candidates.length - 1];
}

/**
 * Serve a file that sits directly inside `assetsDir`. Anything with a path
 * separator or a leading dot is refused, so requests cannot escape the folder.
 * Returns false when nothing was served.
 */
export function serveStatic(pathname: string, res: ServerResponse, assetsDir: string): boolean {
  let name: string;
  try {
    name = decodeURIComponent(pathname.replace(/^\//, '')) || 'index.html';
  } catch {
    return false;
  }
  if (name.includes('/') || name.includes('\\') || name.startsWith('.')) return false;

  const type = CONTENT_TYPES[extname(name)];
  const file = join(assetsDir, name);
  if (!type || !existsSync(file) || !statSync(file).isFile()) return false;

  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
  return true;
}
