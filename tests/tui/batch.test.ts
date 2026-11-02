import { describe, test, expect } from 'bun:test';
import { createStateBatcher } from '../../src/tui/batch.js';

// A controllable scheduler: captures the flush callback so the test drives timing.
function fakeScheduler() {
  let scheduled: (() => void) | null = null;
  let scheduleCount = 0;
  let cancelCount = 0;
  return {
    schedule: (fn: () => void) => {
      scheduled = fn;
      scheduleCount++;
      return () => { cancelCount++; scheduled = null; };
    },
    run: () => { const f = scheduled; scheduled = null; if (f) f(); },
    get scheduleCount() { return scheduleCount; },
    get cancelCount() { return cancelCount; },
    get isScheduled() { return scheduled !== null; },
  };
}

describe('createStateBatcher', () => {
  test('coalesces multiple pushes into a single scheduled flush', () => {
    const s = fakeScheduler();
    const flushes: Array<Map<string, number>> = [];
    const batcher = createStateBatcher<number>(b => flushes.push(b), s.schedule);

    batcher.push('a', 1);
    batcher.push('a', 2);
    batcher.push('b', 3);

    expect(s.scheduleCount).toBe(1);   // only one flush scheduled for the burst
    expect(flushes.length).toBe(0);    // nothing flushed until the scheduler runs

    s.run();

    expect(flushes.length).toBe(1);
    expect(flushes[0].get('a')).toBe(2); // latest value per key wins
    expect(flushes[0].get('b')).toBe(3);
  });

  test('schedules a new flush after the previous one ran', () => {
    const s = fakeScheduler();
    const flushes: Array<Map<string, number>> = [];
    const batcher = createStateBatcher<number>(b => flushes.push(b), s.schedule);

    batcher.push('a', 1);
    s.run();
    expect(flushes.length).toBe(1);

    batcher.push('c', 4);
    expect(s.scheduleCount).toBe(2);
    s.run();
    expect(flushes.length).toBe(2);
    expect(flushes[1].get('c')).toBe(4);
  });

  test('dispose cancels a pending flush', () => {
    const s = fakeScheduler();
    const flushes: Array<Map<string, number>> = [];
    const batcher = createStateBatcher<number>(b => flushes.push(b), s.schedule);

    batcher.push('a', 1);
    batcher.dispose();

    expect(s.cancelCount).toBe(1);
    expect(s.isScheduled).toBe(false);
    s.run(); // no-op; nothing scheduled
    expect(flushes.length).toBe(0);
  });
});
