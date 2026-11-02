import React, { type ReactElement } from 'react';
import { render as inkRender } from 'ink';
import { App, type AppMode } from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import type { DaemonClient } from '../client/daemon-client.js';
import { connectToDaemon } from '../client/connect.js';
import { readConfig, configExists } from '../config/store.js';

export interface LaunchTuiOptions {
  initialMode?: AppMode;
  /** Connects to the background service; defaults to starting it if needed. */
  connect?: () => Promise<DaemonClient>;
  /** Injectable for tests; defaults to ink's render. */
  render?: (element: ReactElement) => { waitUntilExit: () => Promise<unknown> };
}

/**
 * Open the TUI as a client of the background service. The service owns the
 * tunnels, so quitting only disconnects — tunnels keep running.
 */
export async function launchTui(options: LaunchTuiOptions = {}): Promise<void> {
  const client = await (options.connect ?? connectToDaemon)();

  // Fetch zones (silent failure)
  let zones: Array<{ id: string; name: string }> = [];
  try {
    zones = await client.zones();
  } catch {
    // Continue without zones
  }

  // Determine defaultZone from config or zones[0]
  const config = configExists() ? readConfig() : null;
  const defaultZone = config?.defaultZone ?? zones[0]?.name ?? '';

  const render = options.render ?? inkRender;
  const app = render(
    React.createElement(
      ErrorBoundary,
      null,
      React.createElement(App, {
        tunnelService: client,
        zones,
        defaultZone,
        onShutdown: async () => client.close(),
        // The wizard wrote the token to config; have the service pick it up.
        onOnboardingComplete: () => client.reload(),
        initialMode: options.initialMode,
      }),
    ),
  );

  await app.waitUntilExit();
}
