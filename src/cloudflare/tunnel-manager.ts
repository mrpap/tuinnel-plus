import {
  createTunnel,
  getTunnelByName,
  getTunnelToken,
  updateTunnelConfig,
  deleteTunnel,
  createDnsRecord,
  updateDnsRecord,
  deleteDnsRecord,
  listDnsRecords,
  discoverAccountId,
  getAllZones,
} from './api.js';
import type { Tunnel, DNSRecord } from './types.js';
import { buildSingleIngress } from '../cloudflared/config.js';
import { logger } from '../utils/logger.js';

/** Naming convention: CF tunnel names are prefixed to avoid collisions */
const TUNNEL_PREFIX = 'tuinnel-';

function cfTunnelName(name: string): string {
  return `${TUNNEL_PREFIX}${name}`;
}

// -- Tunnel --

export interface TunnelInfo {
  tunnelId: string;
  connectorToken: string;
}

export async function createOrGetTunnel(
  accountId: string,
  name: string,
  token: string,
): Promise<TunnelInfo> {
  const cfName = cfTunnelName(name);
  const result = await createTunnel(accountId, cfName, token);

  let tunnel: Tunnel;
  if ('conflict' in result) {
    // 409: tunnel already exists — fetch by name
    const existing = await getTunnelByName(accountId, cfName, token);
    if (!existing) {
      throw new Error(`Tunnel "${cfName}" reported as existing but could not be found.`);
    }
    tunnel = existing;
  } else {
    tunnel = result;
  }

  const connectorToken = await getTunnelToken(accountId, tunnel.id, token);

  return { tunnelId: tunnel.id, connectorToken };
}

// -- Ingress --

export async function updateIngress(
  accountId: string,
  tunnelId: string,
  hostname: string,
  port: number,
  protocol: 'http' | 'https',
  token: string,
  loopbackAddr: string = '127.0.0.1',
): Promise<void> {
  const config = buildSingleIngress(hostname, port, protocol, loopbackAddr);
  await updateTunnelConfig(accountId, tunnelId, config, token);
}

// -- DNS --

export interface DnsResult {
  recordId: string;
  created: boolean;
  conflict?: string; // Existing CNAME content if pointing to different tunnel
}

export async function createOrVerifyDns(
  zoneId: string,
  hostname: string,
  tunnelId: string,
  token: string,
): Promise<DnsResult> {
  const tunnelCname = `${tunnelId}.cfargotunnel.com`;

  // Check for existing CNAME record
  const existingRecords: DNSRecord[] = [];
  for await (const record of listDnsRecords(zoneId, token, {
    type: 'CNAME',
    name: hostname,
  })) {
    existingRecords.push(record);
  }

  const existing = existingRecords.find(
    (r) => r.type === 'CNAME' && r.name === hostname,
  );

  if (existing) {
    if (existing.content === tunnelCname) {
      // Already points to our tunnel — no-op
      return { recordId: existing.id, created: false };
    }
    // Points to a different tunnel — update to current tunnel
    const updated = await updateDnsRecord(
      zoneId,
      existing.id,
      { type: 'CNAME', name: hostname, content: tunnelCname, proxied: true, ttl: 1 },
      token,
    );
    return { recordId: updated.id, created: false, conflict: existing.content };
  }

  // Create new CNAME record
  const record = await createDnsRecord(
    zoneId,
    {
      type: 'CNAME',
      name: hostname,
      content: tunnelCname,
      proxied: true,
      ttl: 1, // Auto TTL when proxied
    },
    token,
  );

  if ('conflict' in record) {
    // DNS record already exists — re-query to find the existing record
    const retryRecords: DNSRecord[] = [];
    for await (const r of listDnsRecords(zoneId, token, {
      type: 'CNAME',
      name: hostname,
    })) {
      retryRecords.push(r);
    }
    const existingRecord = retryRecords.find(
      (r) => r.type === 'CNAME' && r.name === hostname,
    );
    if (!existingRecord) {
      throw new Error(`DNS record for "${hostname}" reported as existing but could not be found.`);
    }
    if (existingRecord.content === tunnelCname) {
      return { recordId: existingRecord.id, created: false };
    }
    // Points to a different tunnel — update to current tunnel
    const updated = await updateDnsRecord(
      zoneId,
      existingRecord.id,
      { type: 'CNAME', name: hostname, content: tunnelCname, proxied: true, ttl: 1 },
      token,
    );
    return { recordId: updated.id, created: false, conflict: existingRecord.content };
  }

  return { recordId: record.id, created: true };
}

// -- Deletion (DNS + tunnel), resolved by lookup --

export interface DeleteResourcesResult {
  dnsDeleted: boolean;
  tunnelDeleted: boolean;
  /** Non-fatal problems; the caller should surface these so orphans aren't silent. */
  warnings: string[];
}

/**
 * Remove a tunnel's entire Cloudflare footprint: the CNAME DNS record AND the
 * tunnel itself. Resolves the zone, DNS record, and tunnel by lookup, so it works
 * even when the caller has no stored ids (the common case for a stopped tunnel).
 *
 * Best-effort: DNS and tunnel deletion are independent, and failures are collected
 * as warnings rather than thrown, so a partial success still removes what it can.
 * A resource that is already gone is treated as success (idempotent).
 */
export async function deleteTunnelResources(
  name: string,
  config: { subdomain: string; zone: string },
  token: string,
  knownTunnelId?: string | null,
): Promise<DeleteResourcesResult> {
  const hostname = `${config.subdomain}.${config.zone}`;
  const cfName = cfTunnelName(name);
  const warnings: string[] = [];
  let dnsDeleted = false;
  let tunnelDeleted = false;

  let accountId: string;
  try {
    accountId = await discoverAccountId(token);
  } catch (err) {
    // Without an account id we can't touch Cloudflare at all.
    warnings.push(`Could not reach Cloudflare to clean up "${name}": ${errMessage(err)}`);
    return { dnsDeleted, tunnelDeleted, warnings };
  }

  // The CNAME DNS record
  try {
    const zones = await getAllZones(token);
    const zone = zones.find((z) => z.name === config.zone);
    if (!zone) {
      warnings.push(`Zone "${config.zone}" not found; left DNS record ${hostname} in place.`);
    } else {
      let recordId: string | null = null;
      for await (const r of listDnsRecords(zone.id, token, { type: 'CNAME', name: hostname })) {
        if (r.type === 'CNAME' && r.name === hostname) {
          recordId = r.id;
          break;
        }
      }
      if (recordId) {
        await deleteDnsRecord(zone.id, recordId, token);
        dnsDeleted = true;
        logger.success(`DNS record deleted: ${hostname}`);
      } else {
        logger.info(`No DNS record found for ${hostname} (already removed).`);
      }
    }
  } catch (err) {
    warnings.push(`Could not delete DNS record ${hostname}: ${errMessage(err)}`);
  }

  // The tunnel itself, resolving its id by name if the caller didn't have one
  try {
    let tunnelId = knownTunnelId ?? null;
    if (!tunnelId) {
      const existing = await getTunnelByName(accountId, cfName, token);
      tunnelId = existing?.id ?? null;
    }
    if (tunnelId) {
      await deleteTunnel(accountId, tunnelId, token);
      tunnelDeleted = true;
      logger.success(`Tunnel deleted: ${cfName}`);
    } else {
      logger.info(`No Cloudflare tunnel found for ${cfName} (already removed).`);
    }
  } catch (err) {
    warnings.push(`Could not delete tunnel ${cfName}: ${errMessage(err)}`);
  }

  return { dnsDeleted, tunnelDeleted, warnings };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
