import { DaemonClient } from './daemon-client.js';
import { ensureDaemon, findDaemon } from './ensure-daemon.js';
import type { DaemonDescriptor } from '../daemon/descriptor.js';

const endpoint = (d: DaemonDescriptor) => ({ baseUrl: `http://${d.host}:${d.port}`, localToken: d.localToken });

async function clientFor(d: DaemonDescriptor): Promise<DaemonClient> {
  const client = new DaemonClient({
    ...endpoint(d),
    // After a daemon restart, follow its new token/port from daemon.json.
    rediscover: async () => {
      const now = await findDaemon();
      return now ? endpoint(now) : null;
    },
  });
  await client.connect();
  return client;
}

/** Connect to the background service, starting it if it isn't running. */
export async function connectToDaemon(): Promise<DaemonClient> {
  return clientFor(await ensureDaemon());
}

/** Connect to the background service only if it is already running. */
export async function connectIfRunning(): Promise<DaemonClient | null> {
  const d = await findDaemon();
  return d ? clientFor(d) : null;
}
