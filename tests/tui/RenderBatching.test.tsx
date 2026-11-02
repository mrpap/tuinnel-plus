import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../../src/tui/App.js';
import type { TunnelRuntime } from '../../src/types.js';
import { EventEmitter } from 'events';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

describe('stateChange render coalescing', () => {
  test('log-line stateChange events reach the UI after the flush window, not before', async () => {
    const tunnel = makeTunnel('app');
    const tunnels = new Map<string, TunnelRuntime>([['app', tunnel]]);
    const service = new MockTunnelService(tunnels);
    const { lastFrame, stdin } = render(
      <App
        tunnelService={service as any}
        zones={[{ id: 'z1', name: 'example.com' }]}
        defaultZone="example.com"
        onShutdown={async () => {}}
      />
    );

    stdin.write('2'); // logs tab
    await delay(50);
    expect(lastFrame()).toContain('Waiting for connections');

    // Simulate cloudflared emitting a log line: mutate runtime in place + emit,
    // exactly as TunnelService.wireProcess does.
    tunnel.connections.push({
      timestamp: new Date('2024-07-01T14:23:01Z'),
      level: 'INF',
      message: 'Registered tunnel connection',
    });
    service.emit('stateChange', { name: 'app', state: 'connected', tunnel });

    // Throttled: not rendered immediately.
    await delay(30);
    expect(lastFrame()).not.toContain('Registered tunnel connection');

    // Flushed after the coalescing window.
    await delay(220);
    expect(lastFrame()).toContain('Registered tunnel connection');
  });
});
