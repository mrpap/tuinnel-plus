import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'events';
import type { ReactElement } from 'react';
import { launchTui } from '../../src/tui/launch.js';

function fakeClient(calls: string[]) {
  return Object.assign(new EventEmitter(), {
    getAll: () => new Map(),
    get: () => undefined,
    create: async () => 'x',
    update: async () => {},
    delete: async () => {},
    start: async () => { calls.push('start'); },
    stop: async () => { calls.push('stop'); },
    restart: async () => {},
    zones: async () => { calls.push('zones'); return [{ id: 'z1', name: 'example.com' }]; },
    reload: async () => { calls.push('reload'); },
    close: () => { calls.push('close'); },
  });
}

describe('launchTui', () => {
  test('launchTui uses injected connect and closes client on quit without stopping tunnels', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls);
    let appProps: any;

    await launchTui({
      initialMode: 'dashboard',
      connect: async () => client as any,
      // Stand-in for ink's render: grab the App props, then quit as the user would.
      render: (el: ReactElement<any>) => {
        appProps = el.props.children.props;
        return { waitUntilExit: () => appProps.onShutdown() };
      },
    });

    expect(appProps.tunnelService).toBe(client);
    expect(appProps.zones).toEqual([{ id: 'z1', name: 'example.com' }]);
    expect(calls).toContain('close');
    expect(calls).not.toContain('stop');

    await appProps.onOnboardingComplete();
    expect(calls).toContain('reload');
  });

  test('zone lookup failure is silent', async () => {
    const client = fakeClient([]);
    client.zones = async () => { throw new Error('no token'); };
    let appProps: any;
    await launchTui({
      initialMode: 'onboarding',
      connect: async () => client as any,
      render: (el: ReactElement<any>) => {
        appProps = el.props.children.props;
        return { waitUntilExit: async () => {} };
      },
    });
    expect(appProps.zones).toEqual([]);
    expect(appProps.initialMode).toBe('onboarding');
  });
});
