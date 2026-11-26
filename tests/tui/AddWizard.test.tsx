import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { AddWizard } from '../../src/tui/AddWizard.js';
import { press, waitFor } from './wait.js';

const ENTER = '\r';
const DOWN = '\x1B[B';

const ZONES = [
  { id: 'z1', name: 'example.com' },
  { id: 'z2', name: 'example.org' },
];

describe('AddWizard', () => {
  test('submits with Enter when the default zone is left unchanged', async () => {
    let submitted: { port: number; subdomain: string; zone: string } | null = null;
    const { stdin, lastFrame } = render(
      <AddWizard
        defaultZone="example.com"
        zones={ZONES}
        onSubmit={(config) => { submitted = config; }}
        onCancel={() => {}}
      />
    );

    await press({ stdin, lastFrame }, '3000');
    await press({ stdin, lastFrame }, ENTER); // confirm port
    await press({ stdin, lastFrame }, ENTER); // accept suggested subdomain
    await press({ stdin, lastFrame }, ENTER); // confirm zone (unchanged — default zone is first in the list)

    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted?.zone).toBe('example.com');
    expect(submitted?.port).toBe(3000);
  });

  test('submits the newly selected zone when changed', async () => {
    let submitted: { port: number; subdomain: string; zone: string } | null = null;
    const { stdin, lastFrame } = render(
      <AddWizard
        defaultZone="example.com"
        zones={ZONES}
        onSubmit={(config) => { submitted = config; }}
        onCancel={() => {}}
      />
    );

    await press({ stdin, lastFrame }, '3000');
    await press({ stdin, lastFrame }, ENTER); // confirm port
    await press({ stdin, lastFrame }, ENTER); // accept suggested subdomain
    await press({ stdin, lastFrame }, DOWN);  // move to example.org
    await press({ stdin, lastFrame }, ENTER); // confirm zone (changed)

    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted?.zone).toBe('example.org');
    expect(submitted?.port).toBe(3000);
  });
});

describe('AddWizard Esc', () => {
  const ESC = '\x1B';
  const PROMPT = 'Discard changes? Esc again to discard.';

  function wizard() {
    let cancels = 0;
    const app = render(
      <AddWizard defaultZone="example.com" zones={ZONES} onSubmit={() => {}} onCancel={() => { cancels++; }} />
    );
    return { app, cancels: () => cancels };
  }

  test('Esc on an untouched form closes it at once', async () => {
    const { app, cancels } = wizard();
    await press(app, ESC);
    await waitFor(() => expect(cancels()).toBe(1));
  });

  test('Esc after typing asks first; a second Esc discards', async () => {
    const { app, cancels } = wizard();
    await press(app, '3000');
    await press(app, ESC);
    expect(app.lastFrame()).toContain(PROMPT);
    expect(cancels()).toBe(0);
    await press(app, ESC);
    await waitFor(() => expect(cancels()).toBe(1));
  });

  test('Esc pressed straight after typing still asks (no redraw in between)', async () => {
    const { app, cancels } = wizard();
    await press(app, '');
    app.stdin.write('3');
    app.stdin.write(ESC);
    await waitFor(() => expect(app.lastFrame()).toContain(PROMPT));
    expect(cancels()).toBe(0);
  });

  test('another key after the prompt keeps editing', async () => {
    const { app, cancels } = wizard();
    await press(app, '3');
    await press(app, ESC);
    await press(app, '0');
    expect(app.lastFrame()).not.toContain(PROMPT);
    expect(app.lastFrame()).toContain('30');
    expect(cancels()).toBe(0);
  });
});
