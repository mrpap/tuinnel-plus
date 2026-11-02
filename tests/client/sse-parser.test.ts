import { describe, test, expect } from 'bun:test';
import { SseParser } from '../../src/client/sse-parser.js';

describe('SseParser', () => {
  test('frame split across chunks', () => {
    const p = new SseParser();
    expect(p.push('event: tun')).toEqual([]);
    expect(p.push('nel\ndata: {"a":')).toEqual([]);
    expect(p.push('1}\n\nevent: log\ndata: 2\n\n')).toEqual([
      { event: 'tunnel', data: '{"a":1}' },
      { event: 'log', data: '2' },
    ]);
  });

  test('comments ignored', () => {
    const p = new SseParser();
    expect(p.push(': connected\n\n: ping\n\nevent: removed\ndata: {}\n\n')).toEqual([{ event: 'removed', data: '{}' }]);
  });

  test('CRLF supported', () => {
    const p = new SseParser();
    expect(p.push('event: added\r\ndata: x\r\n\r\n')).toEqual([{ event: 'added', data: 'x' }]);
  });

  test('multi-line data joins with newline; default event is message', () => {
    const p = new SseParser();
    expect(p.push('data: a\ndata: b\n\n')).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
});
