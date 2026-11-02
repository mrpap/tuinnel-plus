// Ink renders asynchronously, so fixed sleeps between key presses pass on a fast
// laptop and fail on a slow CI runner. These helpers wait for the screen instead.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface InkApp {
  stdin: { write(data: string): void; listenerCount(event: string): number };
  lastFrame(): string | undefined;
}

/**
 * Ink subscribes to stdin in an effect after it renders, and briefly unsubscribes
 * when the focused input changes. The test stdin drops keys nobody listens to,
 * so wait for a listener before typing.
 */
async function listening(app: InkApp, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (app.stdin.listenerCount('readable') === 0) {
    if (Date.now() - start > timeoutMs) throw new Error('Ink never started listening for input');
    await sleep(5);
  }
}

/** Wait until the frame changes from `before` (if it does at all) and then stops changing. */
async function settle(app: InkApp, before: string | undefined, changeTimeoutMs = 1500, quietMs = 40): Promise<void> {
  const start = Date.now();
  while (app.lastFrame() === before && Date.now() - start < changeTimeoutMs) await sleep(5);
  let last = app.lastFrame();
  let stableSince = Date.now();
  while (Date.now() - stableSince < quietMs && Date.now() - start < changeTimeoutMs + 2000) {
    await sleep(5);
    const frame = app.lastFrame();
    if (frame !== last) {
      last = frame;
      stableSince = Date.now();
    }
  }
}

/** Type `input` and wait for the app to finish redrawing. */
export async function press(app: InkApp, input: string): Promise<void> {
  await listening(app);
  const before = app.lastFrame();
  app.stdin.write(input);
  await settle(app, before);
}

/** Wait for the first render to finish. */
export async function rendered(app: InkApp): Promise<void> {
  await settle(app, undefined);
}

/** Retry `check` until it stops throwing, or rethrow its last error after `timeoutMs`. */
export async function waitFor(check: () => void, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await sleep(10);
    }
  }
}
