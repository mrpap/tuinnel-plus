import { join } from 'path';
import { fileStore } from '../config/store.js';
import { resolveStateDir } from '../config/paths.js';
import { webSettings } from '../config/web.js';
import { daemonPaths, readDescriptor } from '../daemon/descriptor.js';
import * as launchd from '../service/launchd.js';
import * as systemd from '../service/systemd.js';
import { programArgsForCurrentInstall, serviceEnv } from '../service/install-args.js';
import { logger } from '../utils/logger.js';

export function platformService(platform: NodeJS.Platform = process.platform): 'launchd' | 'systemd' | null {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  return null;
}

function requireSupported(): 'launchd' | 'systemd' | null {
  const kind = platformService();
  if (!kind) {
    logger.error('`tuinnel-plus service` supports macOS (launchd) and Linux (systemd).\nRun `tuinnel-plus serve` under your own process manager instead.');
    process.exitCode = 1;
  }
  return kind;
}

type Message = { level: 'success' | 'info' | 'warn'; text: string };

/** What to tell the user after a Linux install. Pure, so the wording can be tested. */
export function linuxInstallMessages(
  r: systemd.InstallResult,
  user: string,
  dashboardLine: string,
  /** A daemon found running outside the service, which is the usual reason it can't start. */
  outsidePid: number | null = null,
): Message[] {
  const out: Message[] = r.running
    ? [{ level: 'success', text: `Installed systemd user service: ${r.unitPath}` }]
    : [{ level: 'warn', text: `Installed systemd user service: ${r.unitPath}, but it did not stay running.` }];
  if (r.replaced) out.push({ level: 'info', text: `Replaced the existing unit at ${r.unitPath}.` });
  if (!r.running) {
    out.push(outsidePid
      ? {
        level: 'warn',
        text: `tuinnel-plus is already running outside the service (pid ${outsidePid}). Stop it with \`kill ${outsidePid}\`, then run \`tuinnel-plus service install\` again.`,
      }
      : {
        level: 'warn',
        text: 'If tuinnel-plus is already running outside the service (for example started by the terminal dashboard), stop that process and run `tuinnel-plus service install` again. '
          + `Details: \`tuinnel-plus service status\` and ${r.logFile ?? '`journalctl --user -u tuinnel-plus`'}`,
      });
  } else {
    out.push({ level: 'info', text: dashboardLine });
  }
  if (r.linger === 'enabled') {
    out.push({ level: 'info', text: `Enabled lingering for ${user}, so the service starts at boot without a login.` });
  } else if (r.linger === 'needs-sudo') {
    out.push({
      level: 'warn',
      text: `Lingering is off, so the service only runs while you are logged in. To start it at boot, run:\n  sudo loginctl enable-linger ${user}`,
    });
  }
  if (r.logFile === null) out.push({ level: 'info', text: 'Logs: journalctl --user -u tuinnel-plus' });
  return out;
}

/** What to tell the user after a Linux uninstall. */
export function linuxUninstallMessages(r: { removed: boolean; lingerOn: boolean }, user: string, unit: string): Message[] {
  if (!r.removed) return [{ level: 'info', text: 'Service not installed.' }];
  const out: Message[] = [{ level: 'success', text: `Removed systemd user service (${unit}). Running tunnels stopped with the service.` }];
  if (r.lingerOn) {
    out.push({ level: 'info', text: `Lingering is still on for ${user}. If nothing else needs it: sudo loginctl disable-linger ${user}` });
  }
  return out;
}

const envFile = () => join(resolveStateDir(), 'service.env');

/** The pid of a daemon that is up for this state directory, if any. */
function runningDaemonPid(): number | null {
  const d = readDescriptor(resolveStateDir());
  if (!d) return null;
  try {
    process.kill(d.pid, 0);
    return d.pid;
  } catch {
    return null;
  }
}

export async function serviceInstallCommand(): Promise<void> {
  const kind = requireSupported();
  if (!kind) return;
  try {
    const web = webSettings(fileStore.read());
    const dashboard = `Dashboard: http://${web.host}:${web.port}`;
    const common = {
      programArgs: programArgsForCurrentInstall(),
      env: serviceEnv(),
      logFile: daemonPaths(resolveStateDir()).logFile,
    };
    if (kind === 'launchd') {
      const path = await launchd.installService(common);
      logger.success(`Installed launchd agent: ${path}`);
      logger.info(`The service starts at login and restarts if it crashes. ${dashboard}`);
    } else {
      const r = await systemd.installService({ ...common, envFile: envFile() });
      const line = `The service starts at boot and restarts if it crashes. ${dashboard}`;
      const outsidePid = r.running ? null : runningDaemonPid();
      for (const m of linuxInstallMessages(r, systemd.defaultDeps.user, line, outsidePid)) logger[m.level](m.text);
      if (!r.running) process.exitCode = 1;
    }
    if (!web.passwordHash) {
      logger.info('No dashboard password yet — set one with `tuinnel-plus password set`, or open the dashboard on this machine.');
    }
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function serviceUninstallCommand(): Promise<void> {
  const kind = requireSupported();
  if (!kind) return;
  if (kind === 'launchd') {
    await launchd.uninstallService();
    logger.success(`Removed launchd agent (${launchd.plistPath()}). Running tunnels stopped with the service.`);
    return;
  }
  const r = await systemd.uninstallService(envFile());
  for (const m of linuxUninstallMessages(r, systemd.defaultDeps.user, systemd.unitPath())) logger[m.level](m.text);
}

export async function serviceStatusCommand(): Promise<void> {
  const kind = requireSupported();
  if (!kind) return;
  if (kind === 'launchd') {
    const s = await launchd.serviceStatus();
    if (!s.installed && !s.loaded) {
      logger.info('Service not installed. Install it with `tuinnel-plus service install`.');
      return;
    }
    const state = s.pid ? `running (pid ${s.pid})` : s.loaded ? 'loaded, not running' : 'installed, not loaded';
    logger.info(`Service ${state}. Plist: ${launchd.plistPath()}`);
    return;
  }
  const s = await systemd.serviceStatus();
  if (!s.installed && !s.active) {
    logger.info('Service not installed. Install it with `tuinnel-plus service install`.');
    return;
  }
  const state = s.active ? (s.pid ? `running (pid ${s.pid})` : 'running') : 'installed, not running';
  logger.info(`Service ${state}. Unit: ${systemd.unitPath()}. Lingering: ${s.linger ? 'on' : 'off'}.`);
}
