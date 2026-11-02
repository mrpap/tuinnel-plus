import { describe, test, expect } from 'bun:test';
import { webSettings } from '../../src/config/web.js';

describe('webSettings', () => {
  test('defaults', () => {
    expect(webSettings(null)).toEqual({
      port: 8484,
      host: '127.0.0.1',
      passwordHash: null,
      accentHue: 292,
      selfExpose: null,
    });
  });

  test('overrides', () => {
    const s = webSettings({ version: 1, tunnels: {}, web: { port: 9000, host: '0.0.0.0' } });
    expect(s.port).toBe(9000);
    expect(s.host).toBe('0.0.0.0');
  });
});
