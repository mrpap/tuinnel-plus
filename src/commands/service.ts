import { fileStore } from '../config/store.js';
import { resolveStateDir } from '../config/paths.js';
import { webSettings } from '../config/web.js';
import { daemonPaths } from '../daemon/descriptor.js';
import {
  installService, uninstallService, serviceStatus, programArgsForCurrentInstall, serviceEnv, plistPath,
} from '../service/launchd.js';
import { logger } from '../utils/logger.js';

function requireMac(): boolean {
  if (process.platform === 'darwin') return true;
  logger.error('`tuinnel-plus service` manages a macOS launchd agent; it is only available on macOS.\nRun `tuinnel-plus serve` under your own process manager instead.');
  process.exitCode = 1;
  return false;
}

export async function serviceInstallCommand(): Promise<void> {
  if (!requireMac()) return;
  try {
    const path = await installService({
      programArgs: programArgsForCurrentInstall(),
      env: serviceEnv(),
      logFile: daemonPaths(resolveStateDir()).logFile,
    });
    const web = webSettings(fileStore.read());
    logger.success(`Installed launchd agent: ${path}`);
    logger.info(`The service starts at login and restarts if it crashes. Dashboard: http://${web.host}:${web.port}`);
    if (!web.passwordHash) {
      logger.info('No dashboard password yet — set one with `tuinnel-plus password set`, or open the dashboard on this machine.');
    }
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function serviceUninstallCommand(): Promise<void> {
  if (!requireMac()) return;
  await uninstallService();
  logger.success(`Removed launchd agent (${plistPath()}). Running tunnels stopped with the service.`);
}

export async function serviceStatusCommand(): Promise<void> {
  if (!requireMac()) return;
  const s = await serviceStatus();
  if (!s.installed && !s.loaded) {
    logger.info('Service not installed. Install it with `tuinnel-plus service install`.');
    return;
  }
  const state = s.pid ? `running (pid ${s.pid})` : s.loaded ? 'loaded, not running' : 'installed, not loaded';
  logger.info(`Service ${state}. Plist: ${plistPath()}`);
}
