import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { EditForm } from '../../src/tui/EditForm.js';
import { press } from './wait.js';

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
    const { stdin, lastFrame } = render(
      <EditForm
        tunnel={TUNNEL}
        zones={ZONES}
        onSubmit={(changes) => { submitted = changes; }}
        onCancel={() => {}}
      />
    );

    await press({ stdin, lastFrame }, ENTER); // confirm port
    await press({ stdin, lastFrame }, ENTER); // confirm subdomain
    await press({ stdin, lastFrame }, ENTER); // confirm zone (unchanged — current zone is first in the list)

    expect(submitted).toEqual({ port: 4322, subdomain: 'myapp', zone: 'example.com' });
  });

  test('saves the newly selected zone when changed', async () => {
    let submitted: { port: number; subdomain: string; zone: string } | null = null;
    const { stdin, lastFrame } = render(
      <EditForm
        tunnel={TUNNEL}
        zones={ZONES}
        onSubmit={(changes) => { submitted = changes; }}
        onCancel={() => {}}
      />
    );

    await press({ stdin, lastFrame }, ENTER); // confirm port
    await press({ stdin, lastFrame }, ENTER); // confirm subdomain
    await press({ stdin, lastFrame }, DOWN);  // move to example.org
    await press({ stdin, lastFrame }, ENTER); // confirm zone (changed)

    expect(submitted).toEqual({ port: 4322, subdomain: 'myapp', zone: 'example.org' });
  });
});
