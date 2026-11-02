import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { AddWizard } from '../../src/tui/AddWizard.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const ENTER = '\r';
const DOWN = '\x1B[B';

const ZONES = [
  { id: 'z1', name: 'example.com' },
  { id: 'z2', name: 'example.org' },
];

describe('AddWizard', () => {
  test('submits with Enter when the default zone is left unchanged', async () => {
    let submitted: { port: number; subdomain: string; zone: string } | null = null;
    const { stdin } = render(
      <AddWizard
        defaultZone="example.com"
        zones={ZONES}
        onSubmit={(config) => { submitted = config; }}
        onCancel={() => {}}
      />
    );

    stdin.write('3000');
    await delay(50);
    stdin.write(ENTER); // confirm port
    await delay(50);
    stdin.write(ENTER); // accept suggested subdomain
    await delay(50);
    stdin.write(ENTER); // confirm zone (unchanged — default zone is first in the list)
    await delay(50);

    expect(submitted).not.toBeNull();
    expect(submitted?.zone).toBe('example.com');
    expect(submitted?.port).toBe(3000);
  });

  test('submits the newly selected zone when changed', async () => {
    let submitted: { port: number; subdomain: string; zone: string } | null = null;
    const { stdin } = render(
      <AddWizard
        defaultZone="example.com"
        zones={ZONES}
        onSubmit={(config) => { submitted = config; }}
        onCancel={() => {}}
      />
    );

    stdin.write('3000');
    await delay(50);
    stdin.write(ENTER); // confirm port
    await delay(50);
    stdin.write(ENTER); // accept suggested subdomain
    await delay(50);
    stdin.write(DOWN);  // move to example.org
    await delay(50);
    stdin.write(ENTER); // confirm zone (changed)
    await delay(50);

    expect(submitted).not.toBeNull();
    expect(submitted?.zone).toBe('example.org');
    expect(submitted?.port).toBe(3000);
  });
});
