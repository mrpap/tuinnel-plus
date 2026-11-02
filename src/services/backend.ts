import type { TunnelRuntime } from '../types.js';
import type { CreateOptions, TunnelServiceEvents } from './tunnel-service.js';

/**
 * The tunnel operations a view (TUI, CLI, web API) drives. Satisfied by the
 * in-process TunnelService and by the HTTP DaemonClient alike, so views are
 * indifferent to which one owns the tunnels.
 */
export interface TunnelBackend {
  getAll(): Map<string, TunnelRuntime>;
  get(name: string): TunnelRuntime | undefined;
  create(opts: CreateOptions): Promise<string>;
  update(name: string, changes: Partial<Pick<CreateOptions, 'port' | 'subdomain' | 'zone' | 'protocol'>>): Promise<void>;
  delete(name: string): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  on(event: keyof TunnelServiceEvents, listener: (payload: any) => void): this;
  off(event: keyof TunnelServiceEvents, listener: (payload: any) => void): this;
}
