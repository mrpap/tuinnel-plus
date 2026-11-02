import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../../src/tui/App.js';
import type { TunnelRuntime } from '../../src/types.js';
import { EventEmitter } from 'events';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const UP = '\x1B[A';
const DOWN = '\x1B[B';
const ESC = '\x1B';

function makeTunnel(name: string, port: number): TunnelRuntime {
  return {
    name,
    config: { port, subdomain: name, zone: 'example.com', protocol: 'http' as const },
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

function renderApp(names: string[]) {
  const tunnels = new Map<string, TunnelRuntime>();
  names.forEach((n, i) => tunnels.set(n, makeTunnel(n, 3000 + i * 10)));
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

describe('Sidebar fuzzy search', () => {
  test('/ opens the sidebar search box (sidebar focused by default)', async () => {
    const { lastFrame, stdin } = renderApp(['angular', 'vite', 'api', 'admin']);

    stdin.write('/');
    await delay(50);

    expect(lastFrame()).toContain('Search:');
  });

  test('typing narrows the tunnel list to matches', async () => {
    const { lastFrame, stdin } = renderApp(['angular', 'vite', 'api', 'admin']);

    stdin.write('/');
    await delay(50);
    stdin.write('vi');
    await delay(50);

    const frame = lastFrame();
    expect(frame).toContain('vite');
    expect(frame).not.toContain('angular');
    expect(frame).not.toContain('admin');
  });

  test('Enter jumps to the highlighted match and restores the full list', async () => {
    const { lastFrame, stdin } = renderApp(['angular', 'vite', 'api', 'admin']);

    stdin.write('/');
    await delay(50);
    stdin.write('vi');
    await delay(50);
    stdin.write('\r'); // Enter
    await delay(50);

    const frame = lastFrame();
    expect(frame).not.toContain('Search:');
    expect(frame).toContain('angular');            // full list restored
    expect(frame).toContain('vite.example.com');   // jumped selection
  });

  test('Esc cancels search and restores the original selection', async () => {
    const { lastFrame, stdin } = renderApp(['angular', 'vite', 'api', 'admin']);

    // angular is selected first by default
    stdin.write('/');
    await delay(50);
    stdin.write('vi'); // selection follows to vite
    await delay(50);
    // selection actually moved away from angular while searching
    expect(lastFrame()).toContain('vite.example.com');
    expect(lastFrame()).not.toContain('angular.example.com');

    stdin.write(ESC);
    await delay(50);

    const frame = lastFrame();
    expect(frame).not.toContain('Search:');
    expect(frame).toContain('angular.example.com'); // original selection restored
    expect(frame).toContain('vite');                // list restored
  });

  test('arrows navigate within the filtered matches, skipping non-matches', async () => {
    // zeta sits between the matches: plain navigation would land on it,
    // search navigation must skip it and land on apex.
    const { lastFrame, stdin } = renderApp(['api', 'zeta', 'apex', 'apollo']);

    stdin.write('/');
    await delay(50);
    stdin.write('ap'); // matches api, apex, apollo; selection -> api
    await delay(50);
    stdin.write(DOWN); // within matches: api -> apex (not zeta)
    await delay(50);
    stdin.write('\r'); // jump
    await delay(50);

    expect(lastFrame()).toContain('apex.example.com');
    expect(lastFrame()).not.toContain('zeta.example.com');
  });
});
