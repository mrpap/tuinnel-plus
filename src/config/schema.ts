import { z } from 'zod';

export const TunnelConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  subdomain: z.string().min(1),
  zone: z.string().min(1),
  protocol: z.enum(['http', 'https']).default('http'),
  lastState: z.enum(['running', 'stopped']).optional(),
  tunnelId: z.string().optional(),
});

export const WebConfigSchema = z.object({
  passwordHash: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  host: z.string().optional(),
  /** Hue (0–359) of the web UI's accent colour. */
  accentHue: z.number().int().min(0).max(359).optional(),
  selfExpose: z.object({
    enabled: z.boolean(),
    subdomain: z.string().min(1),
    zone: z.string().min(1),
  }).optional(),
});

export const ConfigSchema = z.object({
  version: z.literal(1),
  apiToken: z.string().optional(),
  defaultZone: z.string().optional(),
  tunnels: z.record(z.string(), TunnelConfigSchema).default({}),
  web: WebConfigSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type TunnelConfig = z.infer<typeof TunnelConfigSchema>;
export type WebConfig = z.infer<typeof WebConfigSchema>;
