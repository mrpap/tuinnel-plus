import { describe, test, expect } from 'bun:test';
import { keepAutoStarting } from '../../src/daemon/autostart.js';

describe('keepAutoStarting', () => {
  test('retries failed tunnels with backoff until they all start', async () => {
    const results = [['a', 'b'], ['b'], []];
    let calls = 0;
    const logs: string[] = [];
    await keepAutoStarting(async () => results[calls++], {
      delaysMs: [1, 1, 1], isStopped: () => false, log: (m) => logs.push(m),
    });
    expect(calls).toBe(3);
    expect(logs.join('\n')).toContain('Retrying 2 tunnel(s)');
  });

  test('gives up after the last delay and says so', async () => {
    let calls = 0;
    const logs: string[] = [];
    await keepAutoStarting(async () => { calls++; return ['a']; }, {
      delaysMs: [1, 1], isStopped: () => false, log: (m) => logs.push(m),
    });
    expect(calls).toBe(3);
    expect(logs.at(-1)).toContain('Giving up');
  });

  test('stops retrying once the daemon is stopping', async () => {
    let calls = 0;
    let stopped = false;
    await keepAutoStarting(async () => { calls++; stopped = true; return ['a']; }, {
      delaysMs: [1, 1, 1], isStopped: () => stopped, log: () => {},
    });
    expect(calls).toBe(1);
  });
});
