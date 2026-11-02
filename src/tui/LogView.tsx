import React from 'react';
import { Box, Text } from 'ink';
import type { ConnectionEvent } from '../types.js';
import { color } from './use-color.js';

export interface LogViewProps {
  events: ConnectionEvent[];
  filter: string | null;
  paused: boolean;
  publicUrl: string | null;
  scrollOffset?: number;
  onScroll?: (direction: 'up' | 'down' | 'end') => void;
}

export const MAX_VISIBLE = 15;

/**
 * Filter connection events by a case-insensitive substring match on the
 * message or edge location. Shared with App so scroll bounds stay in sync
 * with what LogView actually renders. A null/empty filter matches everything.
 */
export function filterConnectionEvents(
  events: ConnectionEvent[],
  filter: string | null,
): ConnectionEvent[] {
  if (!filter) return events;
  const needle = filter.toLowerCase();
  return events.filter(e =>
    e.message.toLowerCase().includes(needle) ||
    (e.location != null && e.location.toLowerCase().includes(needle)));
}

function levelColor(level: ConnectionEvent['level']): string | undefined {
  switch (level) {
    case 'INF': return color('green');
    case 'WRN': return color('yellow');
    case 'ERR':
    case 'FTL': return color('red');
    default: return undefined;
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour12: false });
}

function formatEventFields(event: ConnectionEvent): string {
  const parts: string[] = [];
  if (event.location) parts.push(`location=${event.location}`);
  if (event.connIndex !== undefined) parts.push(`connIndex=${event.connIndex}`);
  if (event.connectionId) parts.push(`id=${event.connectionId.substring(0, 8)}`);
  if (event.protocol) parts.push(`protocol=${event.protocol}`);
  if (event.edgeIp) parts.push(`edge=${event.edgeIp}`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export function LogView({ events, filter, paused, publicUrl, scrollOffset = 0 }: LogViewProps) {
  const filtered = filterConnectionEvents(events, filter);

  // scrollOffset is the number of lines scrolled up from the live tail (0 = bottom).
  // Clamp it so we never scroll past the oldest event, then slice the window.
  const maxOffset = Math.max(0, filtered.length - MAX_VISIBLE);
  const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const end = filtered.length - offset;
  const start = Math.max(0, end - MAX_VISIBLE);
  const visibleEvents = filtered.slice(start, end);

  // Empty state
  if (events.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold dimColor>{'  '}-- Connection Events --</Text>
        <Text dimColor>
          {'  '}Waiting for connections...{publicUrl ? ` Try visiting ${publicUrl}` : ''}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold dimColor>{'  '}-- Connection Events --</Text>
      {filter !== null && (
        <Text dimColor>{'  '}Filter: {filter || '(type to search)'}</Text>
      )}
      {visibleEvents.map((event, i) => (
        <Text
          key={i}
          dimColor={event.level === 'DBG'}
          color={levelColor(event.level)}
        >
          {'  '}{formatTime(event.timestamp)} {event.level}  {event.message}
          {formatEventFields(event)}
        </Text>
      ))}
      {paused && (
        <Text color={color('yellow')}>{'  '}PAUSED -- press Esc to resume</Text>
      )}
      {filter !== null && filtered.length === 0 && events.length > 0 && (
        <Text dimColor>{'  '}No events matching "{filter}"</Text>
      )}
    </Box>
  );
}
