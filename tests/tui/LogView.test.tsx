import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { LogView } from '../../src/tui/LogView.js';
import type { ConnectionEvent } from '../../src/types.js';

function makeEvent(overrides: Partial<ConnectionEvent> = {}): ConnectionEvent {
  return {
    timestamp: new Date('2024-07-01T14:23:01Z'),
    level: 'INF',
    message: 'Test event',
    ...overrides,
  };
}

describe('LogView', () => {
  test('shows empty state message', () => {
    const { lastFrame } = render(
      <LogView events={[]} filter={null} paused={false} publicUrl="https://app.example.com" />
    );

    const frame = lastFrame();
    expect(frame).toContain('Waiting for connections');
    expect(frame).toContain('https://app.example.com');
  });

  test('shows empty state without URL when publicUrl is null', () => {
    const { lastFrame } = render(
      <LogView events={[]} filter={null} paused={false} publicUrl={null} />
    );

    const frame = lastFrame();
    expect(frame).toContain('Waiting for connections');
  });

  test('renders connection events', () => {
    const events = [
      makeEvent({ message: 'Registered tunnel connection', level: 'INF', location: 'DFW', connIndex: 0 }),
      makeEvent({ message: 'Connection established', level: 'INF' }),
    ];

    const { lastFrame } = render(
      <LogView events={events} filter={null} paused={false} publicUrl={null} />
    );

    const frame = lastFrame();
    expect(frame).toContain('Registered tunnel connection');
    expect(frame).toContain('Connection established');
    expect(frame).toContain('location=DFW');
    expect(frame).toContain('connIndex=0');
  });

  test('shows Connection Events header', () => {
    const events = [makeEvent()];
    const { lastFrame } = render(
      <LogView events={events} filter={null} paused={false} publicUrl={null} />
    );

    expect(lastFrame()).toContain('Connection Events');
  });

  test('applies filter to events', () => {
    const events = [
      makeEvent({ message: 'Registered tunnel connection', location: 'DFW' }),
      makeEvent({ message: 'Connection established' }),
    ];

    const { lastFrame } = render(
      <LogView events={events} filter="Registered" paused={false} publicUrl={null} />
    );

    const frame = lastFrame();
    expect(frame).toContain('Registered tunnel connection');
    expect(frame).not.toContain('Connection established');
  });

  test('filter is case insensitive', () => {
    const events = [
      makeEvent({ message: 'Registered tunnel connection' }),
    ];

    const { lastFrame } = render(
      <LogView events={events} filter="registered" paused={false} publicUrl={null} />
    );

    expect(lastFrame()).toContain('Registered tunnel connection');
  });

  test('filter matches on location', () => {
    const events = [
      makeEvent({ message: 'Registered', location: 'DFW' }),
      makeEvent({ message: 'Registered', location: 'LAX' }),
    ];

    const { lastFrame } = render(
      <LogView events={events} filter="DFW" paused={false} publicUrl={null} />
    );

    const frame = lastFrame();
    expect(frame).toContain('DFW');
    expect(frame).not.toContain('LAX');
  });

  test('shows no matches message when filter excludes all', () => {
    const events = [
      makeEvent({ message: 'Registered tunnel connection' }),
    ];

    const { lastFrame } = render(
      <LogView events={events} filter="nonexistent" paused={false} publicUrl={null} />
    );

    expect(lastFrame()).toContain('No events matching');
  });

  test('shows PAUSED indicator when paused', () => {
    const events = [makeEvent()];

    const { lastFrame } = render(
      <LogView events={events} filter={null} paused={true} publicUrl={null} />
    );

    expect(lastFrame()).toContain('PAUSED');
    expect(lastFrame()).toContain('Esc to resume');
  });

  test('scrollOffset moves the visible window toward older events', () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      makeEvent({ message: `event-${String(i).padStart(2, '0')}` }));

    // offset 0: live tail shows the last 15 (event-05..event-19)
    const tail = render(
      <LogView events={events} filter={null} paused={false} scrollOffset={0} publicUrl={null} />
    );
    expect(tail.lastFrame()).toContain('event-19');
    expect(tail.lastFrame()).not.toContain('event-00');

    // offset 5: window slides up to reveal the oldest events
    const scrolled = render(
      <LogView events={events} filter={null} paused={true} scrollOffset={5} publicUrl={null} />
    );
    expect(scrolled.lastFrame()).toContain('event-00');
    expect(scrolled.lastFrame()).not.toContain('event-19');
  });

  test('shows filter indicator when filter is active', () => {
    const events = [makeEvent()];

    const { lastFrame } = render(
      <LogView events={events} filter="test" paused={false} publicUrl={null} />
    );

    expect(lastFrame()).toContain('Filter:');
  });

  test('shows filter placeholder for empty filter string', () => {
    const events = [makeEvent()];

    const { lastFrame } = render(
      <LogView events={events} filter="" paused={false} publicUrl={null} />
    );

    expect(lastFrame()).toContain('type to search');
  });

  test('renders event fields (protocol, edgeIp)', () => {
    const events = [
      makeEvent({
        message: 'Registered tunnel connection',
        connIndex: 0,
        connectionId: 'abc12345-def',
        location: 'DFW',
        protocol: 'quic',
        edgeIp: '1.2.3.4',
      }),
    ];

    const { lastFrame } = render(
      <LogView events={events} filter={null} paused={false} publicUrl={null} />
    );

    const frame = lastFrame();
    expect(frame).toContain('protocol=quic');
    expect(frame).toContain('edge=1.2.3.4');
    expect(frame).toContain('id=abc12345');
  });
});
