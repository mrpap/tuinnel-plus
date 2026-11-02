import { describe, test, expect } from 'bun:test';
import { toWireTunnel, toWireEvent, fromWireTunnel, fromWireEvent } from '../../src/daemon/wire.js';
import { makeRuntime } from './helpers.js';

describe('wire format', () => {
  test('toWireTunnel strips connectorToken and connections', () => {
    const w = toWireTunnel(makeRuntime('app', {
      connections: [{ timestamp: new Date(), level: 'INF', message: 'hi' }],
    }));
    expect('connectorToken' in w).toBe(false);
    expect('connections' in w).toBe(false);
    expect(w.system).toBe(false);
    expect(w.name).toBe('app');
  });

  test('events round-trip with Date timestamps', () => {
    const e = { timestamp: new Date('2026-10-22T10:00:00Z'), level: 'INF' as const, message: 'up', location: 'ams01' };
    const back = fromWireEvent(JSON.parse(JSON.stringify(toWireEvent(e))));
    expect(back).toEqual(e);
  });

  test('fromWireTunnel restores runtime with null connectorToken', () => {
    const rt = fromWireTunnel(toWireTunnel(makeRuntime('app')));
    expect(rt.connectorToken).toBeNull();
    expect(rt.connections).toEqual([]);
    expect('system' in rt).toBe(false);
  });
});
