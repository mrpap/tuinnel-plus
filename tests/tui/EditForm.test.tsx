import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { EditForm } from '../../src/tui/EditForm.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const ENTER = '\r';
const DOWN = '\x1B[B';

const ZONES = [
  { id: 'z1', name: 'example.com' },
  { id: 'z2', name: 'example.org' },
];

const TUNNEL = { name: 'myapp', port: 4322, subdomain: 'myapp', zone: 'example.com' };

describe('EditForm', () => {
  test('saves with Enter when the zone is left unchanged', async () => {
    let submitted: { port: number; subdomain: string; zone: string } | null = null;
    const { stdin } = render(
      <EditForm
        tunnel={TUNNEL}
        zones={ZONES}
        onSubmit={(changes) => { submitted = changes; }}
        onCancel={() => {}}
      />
    );

    stdin.write(ENTER); // confirm port
    await delay(50);
    stdin.write(ENTER); // confirm subdomain
    await delay(50);
    stdin.write(ENTER); // confirm zone (unchanged — current zone is first in the list)
    await delay(50);

    expect(submitted).toEqual({ port: 4322, subdomain: 'myapp', zone: 'example.com' });
  });

  test('saves the newly selected zone when changed', async () => {
    let submitted: { port: number; subdomain: string; zone: string } | null = null;
    const { stdin } = render(
      <EditForm
        tunnel={TUNNEL}
        zones={ZONES}
        onSubmit={(changes) => { submitted = changes; }}
        onCancel={() => {}}
      />
    );

    stdin.write(ENTER); // confirm port
    await delay(50);
    stdin.write(ENTER); // confirm subdomain
    await delay(50);
    stdin.write(DOWN);  // move to example.org
    await delay(50);
    stdin.write(ENTER); // confirm zone (changed)
    await delay(50);

    expect(submitted).toEqual({ port: 4322, subdomain: 'myapp', zone: 'example.org' });
  });
});
