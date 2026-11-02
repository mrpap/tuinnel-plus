import { useState, useEffect, useRef } from 'react';
import type { TunnelMetrics } from '../../types.js';
import { scrapeMetrics } from '../../metrics/prometheus.js';

export interface MetricsState {
  metrics: TunnelMetrics | null;
  lastScraped: Date | null;
  error: string | null;
}

export function useMetrics(
  addr: string | null,
  interval: number = 3000,
): MetricsState {
  const [metrics, setMetrics] = useState<TunnelMetrics | null>(null);
  const [lastScraped, setLastScraped] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    // Reset on addr change to avoid showing stale data
    setMetrics(null);
    setError(null);
    setLastScraped(null);

    if (!addr) return;

    const poll = async () => {
      try {
        const result = await scrapeMetrics(addr);
        if (mountedRef.current) {
          setMetrics(result);
          setLastScraped(new Date());
          setError(null);
        }
      } catch (err: unknown) {
        if (mountedRef.current) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
        }
      }
    };

    // Run immediately
    poll();
    const id = setInterval(poll, interval);

    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [addr, interval]);

  return { metrics, lastScraped, error };
}
