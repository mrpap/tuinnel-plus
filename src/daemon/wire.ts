import type { ConnectionEvent, TunnelRuntime } from '../types.js';

/** A connection/log event as sent over HTTP (Date → ISO string). */
export type WireEvent = Omit<ConnectionEvent, 'timestamp'> & { timestamp: string };

/**
 * A tunnel as sent over HTTP. Never carries the connector token (a secret) or
 * the log buffer (fetched separately via /logs and streamed over SSE).
 */
export type WireTunnel = Omit<TunnelRuntime, 'connectorToken' | 'connections'> & { system: boolean };

export function toWireTunnel(t: TunnelRuntime, system = false): WireTunnel {
  const { connectorToken: _token, connections: _connections, ...rest } = t;
  return { ...rest, system };
}

export function toWireEvent(e: ConnectionEvent): WireEvent {
  return { ...e, timestamp: e.timestamp.toISOString() };
}

export function fromWireTunnel(w: WireTunnel, connections: ConnectionEvent[] = []): TunnelRuntime {
  const { system: _system, ...rest } = w;
  return { ...rest, connectorToken: null, connections };
}

export function fromWireEvent(w: WireEvent): ConnectionEvent {
  return { ...w, timestamp: new Date(w.timestamp) };
}
