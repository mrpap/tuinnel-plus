import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { DeleteConfirm } from '../../src/tui/DeleteConfirm.js';
import { press } from './wait.js';

describe('DeleteConfirm', () => {
  test('renders tunnel name', () => {
    const { lastFrame } = render(
      <DeleteConfirm
        tunnelName="my-app"
        subdomain="my-app"
        zone="example.com"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    const frame = lastFrame();
    expect(frame).toContain('my-app');
  });

  test('renders warning text', () => {
    const { lastFrame } = render(
      <DeleteConfirm
        tunnelName="my-app"
        subdomain="my-app"
        zone="example.com"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    const frame = lastFrame();
    expect(frame).toContain('cannot be undone');
  });

  test('renders DNS hostname', () => {
    const { lastFrame } = render(
      <DeleteConfirm
        tunnelName="my-app"
        subdomain="my-app"
        zone="example.com"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    const frame = lastFrame();
    expect(frame).toContain('my-app.example.com');
  });

  test('renders confirmation prompt', () => {
    const { lastFrame } = render(
      <DeleteConfirm
        tunnelName="my-app"
        subdomain="my-app"
        zone="example.com"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    const frame = lastFrame();
    expect(frame).toContain('y/N');
  });

  test('renders Delete Tunnel title', () => {
    const { lastFrame } = render(
      <DeleteConfirm
        tunnelName="my-app"
        subdomain="my-app"
        zone="example.com"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    const frame = lastFrame();
    expect(frame).toContain('Delete Tunnel');
  });

  test('calls onConfirm on y key', async () => {
    let confirmed = false;
    const { stdin, lastFrame } = render(
      <DeleteConfirm
        tunnelName="my-app"
        subdomain="my-app"
        zone="example.com"
        onConfirm={() => { confirmed = true; }}
        onCancel={() => {}}
      />
    );

    await press({ stdin, lastFrame }, 'y');
    expect(confirmed).toBe(true);
  });

  test('calls onCancel on n key', async () => {
    let cancelled = false;
    const { stdin, lastFrame } = render(
      <DeleteConfirm
        tunnelName="my-app"
        subdomain="my-app"
        zone="example.com"
        onConfirm={() => {}}
        onCancel={() => { cancelled = true; }}
      />
    );

    await press({ stdin, lastFrame }, 'n');
    expect(cancelled).toBe(true);
  });
});
