import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { AddWizard } from '../../src/tui/AddWizard.js';
import { press } from './wait.js';

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

    expect(submitted).not.toBeNull();
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

    expect(submitted).not.toBeNull();
    expect(submitted?.zone).toBe('example.org');
    expect(submitted?.port).toBe(3000);
  });
});
