import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../../src/tui/App.js';
import type { TunnelRuntime, ConnectionEvent } from '../../src/types.js';
import { EventEmitter } from 'events';
import { press } from './wait.js';

// Key escape sequences understood by ink's input parser
const UP = '\x1B[A';
const DOWN = '\x1B[B';
const PAGE_UP = '\x1B[5~';
const ESC = '\x1B';

function makeEvent(message: string, overrides: Partial<ConnectionEvent> = {}): ConnectionEvent {
  return {
    timestamp: new Date('2024-07-01T14:23:01Z'),
    level: 'INF',
    message,
    ...overrides,
  };
}

function makeTunnel(name: string, connections: ConnectionEvent[]): TunnelRuntime {
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
    connections,
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

function renderApp(connections: ConnectionEvent[]) {
  const tunnels = new Map<string, TunnelRuntime>();
  tunnels.set('app', makeTunnel('app', connections));
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

describe('Logs tab interaction', () => {
  test('/ opens the filter prompt on the logs tab', async () => {
    const { lastFrame, stdin } = renderApp([makeEvent('alpha event'), makeEvent('beta event')]);

    await press({ stdin, lastFrame }, '2'); // logs tab
    await press({ stdin, lastFrame }, '/');

    const frame = lastFrame();
    expect(frame).toContain('Filter:');
    expect(frame).toContain('type to search');
  });

  test('typing after / filters the log events live', async () => {
    const { lastFrame, stdin } = renderApp([makeEvent('alpha event'), makeEvent('beta event')]);

    await press({ stdin, lastFrame }, '2');
    await press({ stdin, lastFrame }, '/');
    await press({ stdin, lastFrame }, 'alpha');

    const frame = lastFrame();
    expect(frame).toContain('alpha event');
    expect(frame).not.toContain('beta event');
  });

  test('Esc clears an active log filter', async () => {
    const { lastFrame, stdin } = renderApp([makeEvent('alpha event'), makeEvent('beta event')]);

    await press({ stdin, lastFrame }, '2');
    await press({ stdin, lastFrame }, '/');
    await press({ stdin, lastFrame }, 'alpha');
    expect(lastFrame()).not.toContain('beta event');

    await press({ stdin, lastFrame }, ESC);

    const frame = lastFrame();
    expect(frame).toContain('alpha event');
    expect(frame).toContain('beta event');
    expect(frame).not.toContain('Filter:');
  });

  test('typing a filter does not trigger global shortcuts (q stays in filter)', async () => {
    const { lastFrame, stdin } = renderApp([makeEvent('quokka event'), makeEvent('beta event')]);

    await press({ stdin, lastFrame }, '2');
    await press({ stdin, lastFrame }, '/');
    await press({ stdin, lastFrame }, 'q'); // must go to the filter, NOT open the quit confirmation

    const frame = lastFrame();
    expect(frame).not.toContain('Stop all tunnels and exit');
    expect(frame).toContain('Filter:');
  });

  test('Backspace edits the filter text', async () => {
    const { lastFrame, stdin } = renderApp([makeEvent('alpha event'), makeEvent('beta event')]);

    await press({ stdin, lastFrame }, '2');
    await press({ stdin, lastFrame }, '/');
    await press({ stdin, lastFrame }, 'alphaz'); // no event matches "alphaz"
    expect(lastFrame()).toContain('No events matching');

    await press({ stdin, lastFrame }, '\x7f'); // Backspace -> "alpha"
    expect(lastFrame()).toContain('alpha event');
  });

  test('Enter applies the filter and re-enables global shortcuts', async () => {
    const { lastFrame, stdin } = renderApp([makeEvent('alpha event'), makeEvent('beta event')]);

    await press({ stdin, lastFrame }, '2');
    await press({ stdin, lastFrame }, '/');
    await press({ stdin, lastFrame }, 'alpha');
    await press({ stdin, lastFrame }, '\r'); // Enter confirms, exits editing
    // filter is retained
    expect(lastFrame()).toContain('Filter:');
    expect(lastFrame()).not.toContain('beta event');

    // shortcuts work again (q is no longer captured by the filter box)
    await press({ stdin, lastFrame }, 'q');
    expect(lastFrame()).toContain('Tunnels keep running in the background service');
  });

  test('up arrow pauses the live log tail', async () => {
    const events = Array.from({ length: 20 }, (_, i) => makeEvent(`event-${String(i).padStart(2, '0')}`));
    const { lastFrame, stdin } = renderApp(events);

    await press({ stdin, lastFrame }, '2');
    await press({ stdin, lastFrame }, UP);

    expect(lastFrame()).toContain('PAUSED');
  });

  test('scrolling up then Esc resumes the live tail', async () => {
    const events = Array.from({ length: 20 }, (_, i) => makeEvent(`event-${String(i).padStart(2, '0')}`));
    const { lastFrame, stdin } = renderApp(events);

    await press({ stdin, lastFrame }, '2');
    await press({ stdin, lastFrame }, UP);
    expect(lastFrame()).toContain('PAUSED');

    await press({ stdin, lastFrame }, ESC);
    expect(lastFrame()).not.toContain('PAUSED');
  });

  test('scrolling up reveals older events that were off-screen', async () => {
    const events = Array.from({ length: 20 }, (_, i) => makeEvent(`event-${String(i).padStart(2, '0')}`));
    const { lastFrame, stdin } = renderApp(events);

    await press({ stdin, lastFrame }, '2');
    // default view shows the last 15 events; event-00 is off-screen
    expect(lastFrame()).not.toContain('event-00');

    await press({ stdin, lastFrame }, PAGE_UP);
    expect(lastFrame()).toContain('event-00');
  });
});
