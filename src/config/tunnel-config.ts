import { readConfig, writeConfig, getDefaultConfig, configExists } from './store.js';
import { suggestSubdomain } from './port-map.js';
import { validateSubdomain } from '../utils/validation.js';
import { prompt } from '../utils/prompt.js';
import { logger } from '../utils/logger.js';
import type { TunnelConfig } from './schema.js';

export interface AddTunnelOptions {
  port: number;
  subdomain?: string;
  zone?: string;
  failOnDuplicate?: boolean;
}

export interface AddTunnelResult {
  name: string;
  config: TunnelConfig;
  isNew: boolean;
}

/**
 * Work out a new tunnel's subdomain and zone from CLI options, the default zone, or
 * interactive prompts. Saves nothing. Used by both `add` and `up` commands.
 */
export async function resolveNewTunnel(
  options: Pick<AddTunnelOptions, 'port' | 'subdomain' | 'zone'>,
  defaultZone?: string,
): Promise<{ name: string; config: TunnelConfig }> {
  const isInteractive = process.stdin.isTTY ?? false;

  // 1. Determine subdomain
  let subdomain: string;
  if (options.subdomain) {
    subdomain = validateSubdomain(options.subdomain)!;
  } else if (isInteractive) {
    const suggestion = suggestSubdomain(options.port, process.cwd());
    const answer = await prompt(`Subdomain: ${suggestion} — accept? (Y/n) `);
    if (answer.toLowerCase() === 'n') {
      const custom = await prompt('Enter subdomain: ');
      if (!custom) {
        logger.error('No subdomain provided.');
        process.exit(1);
      }
      subdomain = validateSubdomain(custom)!;
    } else {
      subdomain = suggestion;
    }
  } else {
    logger.error('--subdomain is required in non-interactive mode.');
    process.exit(1);
  }

  // 2. Determine zone
  let zone: string;
  if (options.zone) {
    zone = options.zone;
  } else if (defaultZone) {
    zone = defaultZone;
  } else if (isInteractive) {
    const answer = await prompt('Enter zone (domain): ');
    if (!answer) {
      logger.error('No zone provided. Run `tuinnel-plus init` to set a default zone.');
      process.exit(1);
    }
    zone = answer;
  } else {
    logger.error('--zone is required (no default zone configured). Run `tuinnel-plus init` first.');
    process.exit(1);
  }

  return { name: subdomain, config: { port: options.port, subdomain, zone, protocol: 'http' } };
}

/**
 * Add a tunnel to the local config file, for when no background service is running
 * (otherwise the service creates it and owns the write).
 */
export async function addTunnelToConfig(options: AddTunnelOptions): Promise<AddTunnelResult> {
  const config = configExists() ? readConfig() ?? getDefaultConfig() : getDefaultConfig();
  const { name, config: tunnelConfig } = await resolveNewTunnel(options, config.defaultZone);

  // 3. Check for duplicate
  if (config.tunnels[name]) {
    if (options.failOnDuplicate) {
      logger.error(`Tunnel "${name}" already exists in config (port ${config.tunnels[name].port}).`);
      console.error(`Use \`tuinnel-plus remove ${name}\` first, or choose a different subdomain.`);
      process.exit(1);
    }
    // Return existing entry
    return { name, config: config.tunnels[name], isNew: false };
  }

  // 4. Save to config
  config.tunnels[name] = tunnelConfig;
  writeConfig(config);

  return { name, config: tunnelConfig, isNew: true };
}
