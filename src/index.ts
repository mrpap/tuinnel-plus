#!/usr/bin/env node

import { Command } from 'commander';
import { setVerbose } from './utils/logger.js';
import { VERSION } from './version.js';

const program = new Command();

program
  .name('tuinnel-plus')
  .description('Manage Cloudflare Tunnels from a terminal dashboard, a web UI, or the command line')
  .version(VERSION, '-v, --version')
  .configureHelp({ showGlobalOptions: true })
  .helpCommand(false);

// Global options
program.option('--verbose', 'Enable verbose output');

// Wire up verbose flag before any command runs
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  if (opts.verbose) {
    setVerbose(true);
  }
});

// Bare command: open the TUI dashboard, or `tuinnel-plus <port>` as a shorthand for `up <port>`
program
  .argument('[port]', 'Start a tunnel for this port (same as `up <port>`)')
  .action(async (port: string | undefined, _options, command) => {
    const globalOpts = command.optsWithGlobals();
    if (globalOpts.verbose) setVerbose(true);

    if (port) {
      const { upCommand } = await import('./commands/up.js');
      await upCommand([port], globalOpts);
      return;
    }

    const { openDashboard } = await import('./commands/dashboard.js');
    await openDashboard();
  });

// tuinnel-plus init
program
  .command('init')
  .description('Set up Cloudflare account')
  .action(async () => {
    const { initCommand } = await import('./commands/init.js');
    await initCommand();
  });

// tuinnel-plus up [ports...]
program
  .command('up')
  .description('Start tunnels for ports (adding them if new) and open the dashboard')
  .argument('[ports...]', 'Ports to tunnel')
  .option('-s, --subdomain <name>', 'Subdomain for a new tunnel')
  .option('-z, --zone <domain>', 'Zone/domain for a new tunnel')
  .option('-q, --quick', 'Quick tunnel (no account needed)')
  .option('--no-tui', 'Return to the prompt; tunnels keep running in the background service')
  .alias('start')
  .action(async (ports: string[], options, command) => {
    const globalOpts = command.optsWithGlobals();
    const { upCommand } = await import('./commands/up.js');
    await upCommand(ports, { ...options, ...globalOpts });
  });

// tuinnel-plus down [names...]
program
  .command('down')
  .description('Stop tunnels')
  .argument('[names...]', 'Tunnel names to stop')
  .option('-c, --clean', 'Delete tunnel and DNS records')
  .option('-a, --all', 'Stop all running tunnels')
  .alias('stop')
  .action(async (names: string[], options, command) => {
    const globalOpts = command.optsWithGlobals();
    const { downCommand } = await import('./commands/down.js');
    await downCommand(names, { ...options, ...globalOpts });
  });

// tuinnel-plus add <port>
program
  .command('add')
  .description('Add tunnel config (does NOT start tunnel)')
  .argument('<port>', 'Local port to tunnel')
  .option('-s, --subdomain <name>', 'Subdomain name (required in non-interactive mode)')
  .option('-z, --zone <domain>', 'Zone/domain to use')
  .action(async (port: string, options, command) => {
    const globalOpts = command.optsWithGlobals();
    const { addCommand } = await import('./commands/add.js');
    await addCommand(port, { ...options, ...globalOpts });
  });

// tuinnel-plus remove <name>
program
  .command('remove')
  .description('Delete a tunnel: stops it and removes it from Cloudflare and config')
  .argument('<name>', 'Tunnel name')
  .alias('rm')
  .action(async (name: string, options, command) => {
    const globalOpts = command.optsWithGlobals();
    const { removeCommand } = await import('./commands/remove.js');
    await removeCommand(name, { ...options, ...globalOpts });
  });

// tuinnel-plus list
program
  .command('list')
  .description('List configured tunnels')
  .option('--json', 'Output as JSON')
  .alias('ls')
  .action(async (options, command) => {
    const globalOpts = command.optsWithGlobals();
    const { listCommand } = await import('./commands/list.js');
    await listCommand({ ...options, ...globalOpts });
  });

// tuinnel-plus status
program
  .command('status')
  .description('Check running tunnel status')
  .option('--json', 'Output as JSON')
  .action(async (options, command) => {
    const globalOpts = command.optsWithGlobals();
    const { statusCommand } = await import('./commands/status.js');
    await statusCommand({ ...options, ...globalOpts });
  });

// tuinnel-plus expose
program
  .command('expose')
  .description('Publish the web UI through a Cloudflare tunnel (or --off to unpublish)')
  .option('--subdomain <name>', 'Subdomain for the web UI')
  .option('--zone <zone>', 'Zone (domain) for the web UI')
  .option('--off', 'Stop exposing the web UI')
  .action(async (options) => {
    const { exposeCommand } = await import('./commands/expose.js');
    await exposeCommand(options);
  });

// tuinnel-plus zones
program
  .command('zones')
  .description('List Cloudflare zones')
  .option('--json', 'Output as JSON')
  .action(async (options, command) => {
    const globalOpts = command.optsWithGlobals();
    const { zonesCommand } = await import('./commands/zones.js');
    await zonesCommand({ ...options, ...globalOpts });
  });

// tuinnel-plus doctor
program
  .command('doctor')
  .description('Run diagnostics')
  .action(async () => {
    const { doctorCommand } = await import('./commands/doctor.js');
    await doctorCommand();
  });

// tuinnel-plus serve
program
  .command('serve')
  .description('Run the background service (API + web UI) that owns all tunnels')
  .option('-p, --port <n>', 'Port for the web UI and API (default 8484)')
  .option('--host <host>', 'Address to bind (default 127.0.0.1)')
  .action(async (options) => {
    const { serveCommand } = await import('./commands/serve.js');
    await serveCommand({
      port: options.port !== undefined ? parseInt(options.port, 10) : undefined,
      host: options.host,
    });
  });

// tuinnel-plus service install|uninstall|status
const service = program
  .command('service')
  .description('Run the background service at login (macOS launchd)');

service
  .command('install')
  .description('Install and start the launchd agent')
  .action(async () => {
    const { serviceInstallCommand } = await import('./commands/service.js');
    await serviceInstallCommand();
  });

service
  .command('uninstall')
  .description('Stop and remove the launchd agent')
  .action(async () => {
    const { serviceUninstallCommand } = await import('./commands/service.js');
    await serviceUninstallCommand();
  });

service
  .command('status')
  .description('Show whether the launchd agent is loaded and running')
  .action(async () => {
    const { serviceStatusCommand } = await import('./commands/service.js');
    await serviceStatusCommand();
  });

// tuinnel-plus password set
const password = program
  .command('password')
  .description('Manage the web UI password');

password
  .command('set')
  .description('Set or change the web UI password')
  .action(async () => {
    const { passwordSetCommand } = await import('./commands/password.js');
    await passwordSetCommand();
  });

// tuinnel-plus purge
program
  .command('purge')
  .description('Clean orphaned Cloudflare resources')
  .action(async () => {
    const { purgeCommand } = await import('./commands/purge.js');
    await purgeCommand();
  });

// MUST use parseAsync for async action handlers
await program.parseAsync(process.argv);
