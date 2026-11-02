import { describe, test, expect } from 'bun:test';
import { reducer, type AppState } from '../../src/tui/App.js';
import type { TunnelRuntime } from '../../src/types.js';

function makeRuntime(name: string, over: Partial<TunnelRuntime> = {}): TunnelRuntime {
  return {
    name,
    config: { port: 3000, subdomain: name, zone: 'example.com', protocol: 'http' },
    state: 'connecting',
    pid: null,
    tunnelId: null,
    publicUrl: null,
    connectorToken: null,
    metricsPort: null,
    uptime: 0,
    lastError: null,
    connections: [],
    ...over,
  };
}

function baseState(tunnels: Map<string, TunnelRuntime>): AppState {
  return {
    mode: 'dashboard',
    tunnels,
    selectedTunnel: tunnels.keys().next().value ?? null,
    focusedPanel: 'sidebar',
    activeModal: null,
    activeTab: 'details',
    showHelp: false,
    notification: null,
    logFilter: null,
    logFilterEditing: false,
    logScrollOffset: 0,
    sidebarFilter: null,
    sidebarFilterEditing: false,
    sidebarSearchReturn: null,
  };
}

describe('reducer UPDATE_TUNNELS', () => {
  test('applies a batch of updates in a single new map', () => {
    const tunnels = new Map<string, TunnelRuntime>();
    tunnels.set('a', makeRuntime('a', { state: 'connecting' }));
    tunnels.set('b', makeRuntime('b', { state: 'connecting' }));
    const state = baseState(tunnels);

    const updates = new Map<string, Partial<TunnelRuntime>>([
      ['a', { state: 'connected' }],
      ['b', { lastError: 'boom' }],
    ]);
    const next = reducer(state, { type: 'UPDATE_TUNNELS', updates });

    expect(next.tunnels.get('a')!.state).toBe('connected');
    expect(next.tunnels.get('b')!.lastError).toBe('boom');
    expect(next.tunnels).not.toBe(state.tunnels); // new map reference -> re-render
  });

  test('ignores updates for tunnels that no longer exist', () => {
    const tunnels = new Map<string, TunnelRuntime>();
    tunnels.set('a', makeRuntime('a'));
    const state = baseState(tunnels);

    const updates = new Map<string, Partial<TunnelRuntime>>([
      ['ghost', { state: 'connected' }],
    ]);
    const next = reducer(state, { type: 'UPDATE_TUNNELS', updates });

    expect(next.tunnels.has('ghost')).toBe(false);
    expect(next.tunnels.get('a')!.state).toBe('connecting');
  });
});
