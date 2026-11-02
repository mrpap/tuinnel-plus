import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../../src/tui/App.js';
import type { TunnelRuntime } from '../../src/types.js';
import { EventEmitter } from 'events';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const CTRL_K = '\x0b';
const DOWN = '\x1B[B';
const ESC = '\x1B';

function makeTunnel(name: string): TunnelRuntime {
  return {
    name,
    config: { port: 3000, subdomain: name, zone: 'example.com', protocol: 'http' as const },
    state: 'connected',
    pid: null,
    tunnelId: null,
    publicUrl: `https://${name}.example.com`,
    connectorToken: null,
    metricsPort: null,
    uptime: 0,
    lastError: null,
    connections: [],
  };
}

class MockTunnelService extends EventEmitter {
  private mockTunnels: Map<string, TunnelRuntime>;
  constructor(tunnels: Map<string, TunnelRuntime>) {
    super();
    this.mockTunnels = tunnels;
  }
  getAll() { return new Map(this.mockTunnels); }
  get(name: string) { return this.mockTunnels.get(name); }
  async create() { return 'test'; }
  async update() {}
  async delete() {}
  async start() {}
  async stop() {}
  async restart() {}
  loadFromConfig() {}
  async autoStart() {}
  saveState() {}
  async shutdown() {}
}

function renderApp(names: string[] = ['app']) {
  const tunnels = new Map<string, TunnelRuntime>();
  names.forEach(n => tunnels.set(n, makeTunnel(n)));
  const service = new MockTunnelService(tunnels);
  return render(
    <App
      tunnelService={service as any}
      zones={[{ id: 'z1', name: 'example.com' }]}
      defaultZone="example.com"
      onShutdown={async () => {}}
    />
  );
}

describe('Command palette', () => {
  test('Ctrl+K opens the command palette', async () => {
    const { lastFrame, stdin } = renderApp();

    stdin.write(CTRL_K);
    await delay(50);

    expect(lastFrame()).toContain('Command Palette');
  });

  test('typing filters the command list', async () => {
    const { lastFrame, stdin } = renderApp();

    stdin.write(CTRL_K);
    await delay(50);
    stdin.write('restart');
    await delay(50);

    const frame = lastFrame();
    expect(frame).toContain('Restart tunnel');
    expect(frame).not.toContain('Add tunnel');
  });

  test('Enter runs the highlighted command (Go to Logs)', async () => {
    const { lastFrame, stdin } = renderApp();

    stdin.write(CTRL_K);
    await delay(50);
    stdin.write('logs');
    await delay(50);
    stdin.write('\r');
    await delay(50);

    const frame = lastFrame();
    expect(frame).not.toContain('Command Palette');   // palette closed
    expect(frame).toContain('Connection Events');       // logs tab active
  });

  test('Esc closes the palette without running anything', async () => {
    const { lastFrame, stdin } = renderApp();

    stdin.write(CTRL_K);
    await delay(50);
    expect(lastFrame()).toContain('Command Palette');

    stdin.write(ESC);
    await delay(50);
    expect(lastFrame()).not.toContain('Command Palette');
  });

  test('running "Add tunnel" opens the add wizard', async () => {
    const { lastFrame, stdin } = renderApp();

    stdin.write(CTRL_K);
    await delay(50);
    stdin.write('add');
    await delay(50);
    stdin.write('\r');
    await delay(50);

    expect(lastFrame()).toContain('Add Tunnel');
  });

  test('arrows move the selection within filtered commands', async () => {
    const { lastFrame, stdin } = renderApp();

    stdin.write(CTRL_K);
    await delay(50);
    stdin.write('go to'); // Go to Details / Logs / Metrics (in that order)
    await delay(50);
    stdin.write(DOWN);   // Details -> Logs
    await delay(50);
    stdin.write('\r');
    await delay(50);

    expect(lastFrame()).toContain('Connection Events'); // ran "Go to Logs", not Details
  });
});
