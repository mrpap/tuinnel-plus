import { discoverAccountId, getAllTunnels, deleteTunnel } from '../cloudflare/api.js';
import { readPids, writePids, isProcessAlive } from '../cloudflared/pid.js';
import type { ConfigStore } from '../config/store.js';

type PidStore = ReturnType<typeof readPids>;

export interface PurgePlan {
  orphaned: Array<{ id: string; name: string; status: string }>;
  /** Unconfigured tunnels that still have live connections — running elsewhere, so left alone. */
  active: Array<{ id: string; name: string; status: string }>;
  stalePids: string[];
}

export interface PurgeResult {
  deleted: string[];
  failed: Array<{ name: string; error: string }>;
  cleanedPids: number;
}

/**
 * Find tuinnel-managed Cloudflare tunnels that no longer have a local config
 * entry, plus PID entries whose process is gone. Read-only. A tunnel with live
 * connections is never an orphan: another machine or install is running it.
 */
export async function findOrphans(
  token: string,
  store: ConfigStore,
  deps: { readPids?: () => PidStore; isAlive?: (pid: number) => boolean } = {},
): Promise<PurgePlan & { accountId: string }> {
  const pidsOf = deps.readPids ?? readPids;
  const isAlive = deps.isAlive ?? isProcessAlive;

  const accountId = await discoverAccountId(token);
  const allTunnels = await getAllTunnels(accountId, token);
  const managed = allTunnels.filter((t) => t.name.startsWith('tuinnel-'));

  const config = store.read();
  const configured = new Set(Object.keys(config?.tunnels ?? {}).map((n) => `tuinnel-${n}`));
  const unconfigured = managed
    .filter((t) => !configured.has(t.name))
    .map((t) => ({ id: t.id, name: t.name, status: t.status }));
  const isLive = (t: { status: string }) => t.status === 'healthy' || t.status === 'degraded';
  const orphaned = unconfigured.filter((t) => !isLive(t));
  const active = unconfigured.filter(isLive);

  const pids = pidsOf();
  const stalePids = Object.keys(pids).filter((name) => !isAlive(pids[name].pid));

  return { accountId, orphaned, active, stalePids };
}

/** Delete the orphans found by findOrphans and drop stale PID entries. */
export async function purgeOrphans(
  plan: PurgePlan & { accountId: string },
  token: string,
  deps: { readPids?: () => PidStore; writePids?: (pids: PidStore) => void } = {},
): Promise<PurgeResult> {
  const result: PurgeResult = { deleted: [], failed: [], cleanedPids: 0 };

  for (const t of plan.orphaned) {
    try {
      await deleteTunnel(plan.accountId, t.id, token);
      result.deleted.push(t.name);
    } catch (err) {
      result.failed.push({ name: t.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (plan.stalePids.length > 0) {
    const cleaned = (deps.readPids ?? readPids)();
    for (const name of plan.stalePids) delete cleaned[name];
    (deps.writePids ?? writePids)(cleaned);
    result.cleanedPids = plan.stalePids.length;
  }

  return result;
}
