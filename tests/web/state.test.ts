import { describe, test, expect } from 'bun:test';
// @ts-expect-error — plain browser ES module, no type declarations
import {
  initialState, applySnapshot, applyEvent, applyLogs, needsLogHistory, visibleTunnels, tunnelCounts, stateTone, stateLabel, formatUptime,
  parseRoute, routeHash, validateTunnelForm, nextTheme, themeLabel,
  oklchToHex, accentHex, ACCENT_PRESETS, DEFAULT_ACCENT_HUE, brandSvg,
} from '../../src/web/state.js';

const wire = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  config: { port: 3000, subdomain: name, zone: 'example.com', protocol: 'http' },
  state: 'stopped',
  pid: null,
  tunnelId: null,
  publicUrl: `https://${name}.example.com`,
  metricsPort: null,
  connectedAt: 0,
  lastError: null,
  system: false,
  ...extra,
});

const ev = (message: string) => ({ timestamp: '2026-10-22T10:00:00.000Z', level: 'INF', message });

describe('web state', () => {
  test('snapshot loads tunnels without selecting one', () => {
    const s = applySnapshot(initialState(), [wire('zeta'), wire('alpha')]);
    expect(Object.keys(s.tunnels).sort()).toEqual(['alpha', 'zeta']);
    expect(s.selected).toBeNull();
  });

  test('snapshot then tunnel event updates state', () => {
    let s = applySnapshot(initialState(), [wire('app')]);
    s = applyEvent(s, 'tunnel', { name: 'app', state: 'connected', tunnel: wire('app', { state: 'connected' }) });
    expect(s.tunnels.app.state).toBe('connected');
  });

  test('snapshot keeps an existing selection and logs', () => {
    let s = applySnapshot(initialState(), [wire('a'), wire('b')]);
    s = { ...s, selected: 'b' };
    s = applyLogs(s, 'b', [ev('kept')]);
    s = applySnapshot(s, [wire('a'), wire('b')]);
    expect(s.selected).toBe('b');
    expect(s.logs.b.map((e: any) => e.message)).toEqual(['kept']);
  });

  test('log events append and cap at 1000', () => {
    let s = applySnapshot(initialState(), [wire('app')]);
    for (let i = 0; i < 1005; i++) s = applyEvent(s, 'log', { name: 'app', event: ev(`l${i}`) });
    expect(s.logs.app.length).toBe(1000);
    expect(s.logs.app[0].message).toBe('l5');
    expect(s.logs.app[999].message).toBe('l1004');
  });

  test('a live log line does not count as loaded history', () => {
    let s = applySnapshot(initialState(), [wire('app')]);
    expect(needsLogHistory(s, 'app')).toBe(true);
    s = applyEvent(s, 'log', { name: 'app', event: ev('live') });
    expect(needsLogHistory(s, 'app')).toBe(true);
    s = applyLogs(s, 'app', [ev('old'), ev('live')]);
    expect(needsLogHistory(s, 'app')).toBe(false);
  });

  test('loaded history survives a snapshot but not removal', () => {
    let s = applySnapshot(initialState(), [wire('a'), wire('b')]);
    s = applyLogs(applyLogs(s, 'a', []), 'b', []);
    s = applySnapshot(s, [wire('a'), wire('b')]);
    expect(needsLogHistory(s, 'a')).toBe(false);
    s = applyEvent(s, 'removed', { name: 'b' });
    s = applyEvent(s, 'added', { name: 'b', tunnel: wire('b') });
    expect(needsLogHistory(s, 'b')).toBe(true);
  });

  test('added tunnel appears without changing the selection', () => {
    let s = applySnapshot(initialState(), []);
    s = applyEvent(s, 'added', { name: 'new', tunnel: wire('new') });
    expect(s.tunnels.new.name).toBe('new');
    expect(s.selected).toBeNull();
  });

  test('removing the selected tunnel clears the selection', () => {
    let s = applySnapshot(initialState(), [wire('a'), wire('b')]);
    s = { ...s, selected: 'b' };
    s = applyEvent(s, 'removed', { name: 'b' });
    expect(s.tunnels.b).toBeUndefined();
    expect(s.selected).toBeNull();
  });

  test('visibleTunnels searches case-insensitively and sorts', () => {
    let s = applySnapshot(initialState(), [wire('Zeta'), wire('alpha'), wire('beta', { config: { port: 1, subdomain: 'beta', zone: 'example.org', protocol: 'http' } })]);
    expect(visibleTunnels(s).map((t: any) => t.name)).toEqual(['alpha', 'beta', 'Zeta']);
    s = { ...s, filter: 'ZE' };
    expect(visibleTunnels(s).map((t: any) => t.name)).toEqual(['Zeta']);
    s = { ...s, filter: 'org' };
    expect(visibleTunnels(s).map((t: any) => t.name)).toEqual(['beta']);
    s = { ...s, filter: '3000' };
    expect(visibleTunnels(s).map((t: any) => t.name)).toEqual(['alpha', 'Zeta']);
  });

  test('visibleTunnels narrows to running or stopped', () => {
    let s = applySnapshot(initialState(), [
      wire('up', { state: 'connected' }), wire('starting', { state: 'connecting' }),
      wire('down'), wire('broken', { state: 'error' }),
    ]);
    s = { ...s, show: 'running' };
    expect(visibleTunnels(s).map((t: any) => t.name)).toEqual(['starting', 'up']);
    s = { ...s, show: 'stopped' };
    expect(visibleTunnels(s).map((t: any) => t.name)).toEqual(['broken', 'down']);
  });

  test('tunnelCounts splits running from stopped', () => {
    const s = applySnapshot(initialState(), [wire('a', { state: 'connected' }), wire('b'), wire('c', { state: 'error' })]);
    expect(tunnelCounts(s)).toEqual({ total: 3, running: 1, stopped: 2 });
  });

  test('stateTone groups states for colouring', () => {
    expect(stateTone('connected')).toBe('ok');
    for (const st of ['connecting', 'restarting', 'creating']) expect(stateTone(st)).toBe('warn');
    for (const st of ['error', 'port_down', 'disconnected']) expect(stateTone(st)).toBe('danger');
    expect(stateTone('stopped')).toBe('muted');
    expect(stateLabel('port_down')).toBe('port down');
  });

  test('formatUptime is compact and blank until connected', () => {
    const now = 1_000_000_000;
    expect(formatUptime(0, now)).toBe('—');
    expect(formatUptime(now - 42_000, now)).toBe('42s');
    expect(formatUptime(now - (5 * 60 + 3) * 1000, now)).toBe('5m 3s');
    expect(formatUptime(now - (2 * 3600 + 7 * 60) * 1000, now)).toBe('2h 7m');
    expect(formatUptime(now - (3 * 86400 + 4 * 3600) * 1000, now)).toBe('3d 4h');
  });
});

describe('routes', () => {
  test('parse the address-bar hash into a view', () => {
    expect(parseRoute('')).toEqual({ view: 'overview' });
    expect(parseRoute('#/')).toEqual({ view: 'overview' });
    expect(parseRoute('#/new')).toEqual({ view: 'new' });
    expect(parseRoute('#/settings')).toEqual({ view: 'settings' });
    expect(parseRoute('#/tunnel/my-app')).toEqual({ view: 'tunnel', name: 'my-app' });
    expect(parseRoute('#/tunnel/a%20b')).toEqual({ view: 'tunnel', name: 'a b' });
    expect(parseRoute('#/nonsense')).toEqual({ view: 'overview' });
    expect(parseRoute('#/tunnel/')).toEqual({ view: 'overview' });
  });

  test('routeHash is the inverse of parseRoute', () => {
    for (const r of [{ view: 'overview' }, { view: 'new' }, { view: 'settings' }, { view: 'tunnel', name: 'a b' }]) {
      expect(parseRoute(routeHash(r))).toEqual(r);
    }
  });
});

describe('validateTunnelForm', () => {
  test('rejects port 0, bad subdomain, empty zone', () => {
    const r = validateTunnelForm({ port: '0', subdomain: '-bad-', zone: '', protocol: 'http' });
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(['port', 'subdomain', 'zone']);
  });

  test('rejects non-numeric and out-of-range ports', () => {
    expect(validateTunnelForm({ port: 'abc', subdomain: 'app', zone: 'x.dev', protocol: 'http' }).ok).toBe(false);
    expect(validateTunnelForm({ port: '65536', subdomain: 'app', zone: 'x.dev', protocol: 'http' }).ok).toBe(false);
  });

  test('accepts valid input, normalizing port and subdomain case', () => {
    expect(validateTunnelForm({ port: '3000', subdomain: 'My-App', zone: 'x.dev', protocol: 'https' })).toEqual({
      ok: true,
      value: { port: 3000, subdomain: 'my-app', zone: 'x.dev', protocol: 'https' },
    });
  });
});

describe('theme choice', () => {
  test('cycles system → light → dark → system', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
  });

  test('an unknown stored value is treated as system', () => {
    expect(nextTheme('purple')).toBe('light');
    expect(nextTheme(null)).toBe('light');
    expect(themeLabel('purple')).toBe('System');
  });

  test('labels name the current choice', () => {
    expect(themeLabel('system')).toBe('System');
    expect(themeLabel('light')).toBe('Light');
    expect(themeLabel('dark')).toBe('Dark');
  });
});

describe('accent colour', () => {
  test('oklchToHex matches reference sRGB colours', () => {
    expect(oklchToHex(1, 0, 0)).toBe('#ffffff');
    expect(oklchToHex(0, 0, 0)).toBe('#000000');
    expect(oklchToHex(0.6279554, 0.2576833, 29.2338851)).toBe('#ff0000');
    expect(oklchToHex(0.4520137, 0.3132144, 264.0520206)).toBe('#0000ff');
  });

  test('out-of-gamut colours are clamped, not wrapped', () => {
    expect(oklchToHex(0.9, 0.4, 140)).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('the default accent is the purple from the design and a preset', () => {
    expect(DEFAULT_ACCENT_HUE).toBe(292);
    expect(ACCENT_PRESETS.map((p: any) => p.hue)).toContain(292);
    expect(accentHex(292)).toBe(oklchToHex(0.55, 0.21, 292));
    for (const p of ACCENT_PRESETS) expect(p.hue).toBeGreaterThanOrEqual(0);
  });

  test('brandSvg paints accent parts in the accent and the rest as ink', () => {
    const art = { viewBox: '0 0 10 10', parts: [[true, true, 'M0 0h1'], [false, false, 'M1 1h1']] };
    const svg = brandSvg(art, '#123456');
    expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">');
    expect(svg).toContain('<path fill="#123456" fill-rule="evenodd" d="M0 0h1"/>');
    expect(svg).toContain('<path class="ink" d="M1 1h1"/>');
    expect(svg).toContain('prefers-color-scheme: dark');
  });
});
