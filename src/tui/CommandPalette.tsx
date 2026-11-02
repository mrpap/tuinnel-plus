import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { color } from './use-color.js';

export interface PaletteCommand {
  id: string;
  title: string;
}

export interface CommandPaletteProps {
  commands: PaletteCommand[];
  onExecute: (id: string) => void;
  onClose: () => void;
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(c => c.title.toLowerCase().includes(q));
}

export function CommandPalette({ commands, onExecute, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const filtered = filterCommands(commands, query);
  const clampedIndex = Math.min(index, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      const cmd = filtered[clampedIndex];
      if (cmd) onExecute(cmd.id);
      return;
    }
    if (key.upArrow) {
      setIndex(i => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex(i => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1));
      setIndex(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery(q => q + input);
      setIndex(0);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('cyan')} paddingX={1}>
      <Text bold color={color('cyan')}>Command Palette</Text>
      <Text>
        {'> '}{query}
        {query.length === 0 && <Text dimColor>type to search…</Text>}
      </Text>
      <Text> </Text>
      {filtered.length === 0 && <Text dimColor>No matching commands</Text>}
      {filtered.map((cmd, i) => (
        <Text
          key={cmd.id}
          backgroundColor={i === clampedIndex ? 'gray' : undefined}
          bold={i === clampedIndex}
        >
          {i === clampedIndex ? '› ' : '  '}{cmd.title}
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>↑↓ navigate · Enter run · Esc close</Text>
    </Box>
  );
}
