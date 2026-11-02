import type { Config } from './schema.js';

export const DEFAULT_WEB_PORT = 8484;
export const DEFAULT_WEB_HOST = '127.0.0.1';
export const DEFAULT_ACCENT_HUE = 292;

export interface WebSettings {
  port: number;
  host: string;
  passwordHash: string | null;
  accentHue: number;
  selfExpose: { enabled: boolean; subdomain: string; zone: string } | null;
}

/** Resolve the daemon's web settings from config, applying defaults. */
export function webSettings(config: Config | null): WebSettings {
  const web = config?.web;
  return {
    port: web?.port ?? DEFAULT_WEB_PORT,
    host: web?.host ?? DEFAULT_WEB_HOST,
    passwordHash: web?.passwordHash ?? null,
    accentHue: web?.accentHue ?? DEFAULT_ACCENT_HUE,
    selfExpose: web?.selfExpose ?? null,
  };
}
