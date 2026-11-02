import { describe, test, expect } from 'bun:test';
import { parsePrometheusText, mapToTunnelMetrics } from '../../src/metrics/prometheus.js';

describe('prometheus parsing', () => {
  test('parses a bare metric line', () => {
    expect(parsePrometheusText('# HELP x\ncloudflared_tunnel_total_requests 42\n')).toEqual({
      cloudflared_tunnel_total_requests: [{ labels: '', value: 42 }],
    });
  });

  test('maps response codes by status_code label', () => {
    const raw = parsePrometheusText(
      'cloudflared_tunnel_response_by_code{status_code="200"} 142\n' +
      'cloudflared_tunnel_response_by_code{status_code="404"} 3\n',
    );
    const m = mapToTunnelMetrics(raw);
    expect(m.responseCodeCounts).toEqual({ '200': 142, '404': 3 });
    expect(m.totalRequests).toBe(0);
  });
});
