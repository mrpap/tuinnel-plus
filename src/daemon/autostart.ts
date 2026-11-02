/** Seconds between auto-start retries: quick at first (boot-time network), then every minute. */
export const AUTOSTART_RETRY_DELAYS_MS = [5, 10, 20, 40, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60].map((s) => s * 1000);

/**
 * Run `attempt` (which starts the tunnels that should be running and returns
 * the ones that failed) until everything is up, the delays run out, or the
 * daemon stops. At login launchd often starts us before the network is up.
 */
export async function keepAutoStarting(
  attempt: () => Promise<string[]>,
  o: { delaysMs: number[]; isStopped: () => boolean; log: (msg: string) => void },
): Promise<void> {
  let failed = await attempt();
  for (const delay of o.delaysMs) {
    if (failed.length === 0 || o.isStopped()) return;
    o.log(`Retrying ${failed.length} tunnel(s) in ${Math.round(delay / 1000)}s: ${failed.join(', ')}`);
    await new Promise((r) => setTimeout(r, delay));
    if (o.isStopped()) return;
    failed = await attempt();
  }
  if (failed.length > 0) {
    o.log(`Giving up auto-starting ${failed.join(', ')} — start them from the TUI or web UI.`);
  }
}
