/**
 * Coalesces frequent keyed updates into throttled batches so a burst of
 * events (e.g. one per cloudflared log line) triggers a single flush instead
 * of one re-render each. The scheduler is injected so it can be driven by a
 * timer in production and deterministically in tests.
 *
 * @param onFlush  called with the accumulated batch (latest value per key)
 * @param schedule schedules a flush and returns a cancel function
 */
export interface StateBatcher<T> {
  push(key: string, value: T): void;
  dispose(): void;
}

export function createStateBatcher<T>(
  onFlush: (batch: Map<string, T>) => void,
  schedule: (flush: () => void) => () => void,
): StateBatcher<T> {
  let pending: Map<string, T> | null = null;
  let cancel: (() => void) | null = null;

  const flush = () => {
    cancel = null;
    const batch = pending;
    pending = null;
    if (batch && batch.size > 0) onFlush(batch);
  };

  return {
    push(key, value) {
      if (!pending) pending = new Map();
      pending.set(key, value);
      if (!cancel) cancel = schedule(flush);
    },
    dispose() {
      if (cancel) cancel();
      cancel = null;
      pending = null;
    },
  };
}
