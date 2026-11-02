import { getToken, fileStore } from '../config/store.js';
import { readPids } from '../cloudflared/pid.js';
import { findOrphans, purgeOrphans } from '../services/purge.js';
import { logger } from '../utils/logger.js';
import { confirm } from '../utils/prompt.js';

export async function purgeCommand(): Promise<void> {
  try {
    const token = getToken();

    logger.info('Scanning for orphaned tunnels...');
    const plan = await findOrphans(token, fileStore);
    const { orphaned, active, stalePids } = plan;

    if (active.length > 0) {
      logger.info(
        `Skipping ${active.length} unconfigured tunnel${active.length !== 1 ? 's' : ''} with live connections ` +
        `(running on another machine?): ${active.map((t) => t.name).join(', ')}`,
      );
    }

    if (orphaned.length === 0 && stalePids.length === 0) {
      logger.info('No orphaned tunnels found.');
      return;
    }

    if (orphaned.length > 0) {
      console.error(`\nFound ${orphaned.length} orphaned tunnel${orphaned.length !== 1 ? 's' : ''} on Cloudflare:`);
      for (const t of orphaned) {
        console.error(`  - ${t.name} (id: ${t.id.substring(0, 8)}..., status: ${t.status})`);
      }
    }

    if (stalePids.length > 0) {
      const pids = readPids();
      console.error(`\nFound ${stalePids.length} stale PID entr${stalePids.length !== 1 ? 'ies' : 'y'}:`);
      for (const name of stalePids) {
        console.error(`  - ${name} (PID ${pids[name]?.pid}, process dead)`);
      }
    }

    if (!process.stdin.isTTY) {
      logger.error('Cannot prompt for confirmation in non-interactive mode.\nRe-run in an interactive terminal.');
      process.exitCode = 2;
      return;
    }

    const confirmed = await confirm('\nClean up these resources? (y/N) ', false);
    if (!confirmed) {
      logger.info('Cancelled.');
      return;
    }

    const result = await purgeOrphans(plan, token);

    for (const name of result.deleted) logger.success(`Deleted tunnel ${name}`);
    for (const f of result.failed) logger.error(`Failed to delete ${f.name}: ${f.error}`);

    if (result.cleanedPids > 0) {
      logger.success(`Cleaned ${result.cleanedPids} stale PID entr${result.cleanedPids !== 1 ? 'ies' : 'y'}.`);
    }
    if (result.deleted.length > 0) {
      logger.success(`Purged ${result.deleted.length} orphaned tunnel${result.deleted.length !== 1 ? 's' : ''}.`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(msg);
    process.exitCode = 1;
  }
}
