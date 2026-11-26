import type { ServerResponse } from 'http';
import type { TunnelBackend } from '../services/backend.js';
import type { ConnectionEvent, TunnelRuntime, TunnelState } from '../types.js';
import { toWireEvent, toWireTunnel } from './wire.js';

const DEFAULT_PING_MS = 25_000;

/**
 * Bridges TunnelService events to Server-Sent Events. One hub serves every
 * connected browser and TUI, so all views re-render from the same feed.
 */
export class SseHub {
  /** Each stream and the browser session it belongs to (null for token-authenticated local clients). */
  private clients = new Map<ServerResponse, string | null>();
  private lastSentEvent = new Map<string, ConnectionEvent>();
  private pingTimer: ReturnType<typeof setInterval>;
  private isSystemTunnel: (name: string) => boolean;
  private sessionValid: (id: string) => boolean;

  private onStateChange = ({ name, state, tunnel }: { name: string; state: TunnelState; tunnel: TunnelRuntime }) => {
    this.broadcast('tunnel', { name, state, tunnel: toWireTunnel(tunnel, this.isSystemTunnel(name)) });
    const last = tunnel.connections[tunnel.connections.length - 1];
    if (last && last !== this.lastSentEvent.get(name)) {
      this.lastSentEvent.set(name, last);
      this.broadcast('log', { name, event: toWireEvent(last) });
    }
  };

  private onAdded = ({ name, tunnel }: { name: string; tunnel: TunnelRuntime }) => {
    this.broadcast('added', { name, tunnel: toWireTunnel(tunnel, this.isSystemTunnel(name)) });
  };

  private onRemoved = ({ name }: { name: string }) => {
    this.lastSentEvent.delete(name);
    this.broadcast('removed', { name });
  };

  constructor(
    private service: TunnelBackend,
    opts: { pingMs?: number; isSystemTunnel?: (name: string) => boolean; sessionValid?: (id: string) => boolean } = {},
  ) {
    this.isSystemTunnel = opts.isSystemTunnel ?? (() => false);
    this.sessionValid = opts.sessionValid ?? (() => true);
    service.on('stateChange', this.onStateChange);
    service.on('tunnelAdded', this.onAdded);
    service.on('tunnelRemoved', this.onRemoved);
    // Sessions also expire on their own, so each ping first drops streams whose session is gone.
    this.pingTimer = setInterval(() => {
      this.dropInvalidSessions();
      this.write(': ping\n\n');
    }, opts.pingMs ?? DEFAULT_PING_MS);
    this.pingTimer.unref?.();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  attach(res: ServerResponse, sessionId: string | null = null): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    this.clients.set(res, sessionId);
    // Bun's node:http fires 'close' on the socket/request but not the response.
    const drop = () => { this.clients.delete(res); };
    res.on('close', drop);
    res.socket?.once('close', drop);
  }

  /** Hand a session's streams to its replacement (the browser that just changed the password). */
  moveSession(from: string, to: string): void {
    for (const [res, sid] of this.clients) if (sid === from) this.clients.set(res, to);
  }

  /** End every browser stream whose session was signed out, revoked or has expired. */
  dropInvalidSessions(): void {
    for (const [res, sid] of this.clients) {
      if (sid !== null && !this.sessionValid(sid)) {
        this.clients.delete(res);
        res.end();
      }
    }
  }

  close(): void {
    clearInterval(this.pingTimer);
    this.service.off('stateChange', this.onStateChange);
    this.service.off('tunnelAdded', this.onAdded);
    this.service.off('tunnelRemoved', this.onRemoved);
    for (const res of this.clients.keys()) res.end();
    this.clients.clear();
  }

  private broadcast(event: string, data: unknown): void {
    this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private write(frame: string): void {
    for (const res of this.clients.keys()) res.write(frame);
  }
}
