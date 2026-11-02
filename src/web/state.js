// Pure view-state for the web UI. No DOM access — unit-tested from tests/web.

export const MAX_LOGS = 1000;

export function initialState() {
  return { tunnels: {}, logs: {}, selected: null, filter: '', show: 'all', tab: 'details' };
}

function sortedNames(tunnels) {
  return Object.keys(tunnels).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** The selection survives only while its tunnel exists. */
function keepSelection(state, tunnels) {
  return state.selected && tunnels[state.selected] ? state.selected : null;
}

/** Replace all tunnels from GET /api/tunnels, keeping the selection and logs where possible. */
export function applySnapshot(state, wireTunnels) {
  const tunnels = {};
  for (const t of wireTunnels) tunnels[t.name] = t;
  const logs = {};
  for (const name of Object.keys(tunnels)) logs[name] = state.logs[name] ?? [];
  return { ...state, tunnels, logs, selected: keepSelection(state, tunnels) };
}

/** Replace one tunnel's log buffer (from GET /api/tunnels/:name/logs). */
export function applyLogs(state, name, events) {
  return { ...state, logs: { ...state.logs, [name]: events.slice(-MAX_LOGS) } };
}

/** Apply one SSE event: tunnel | log | added | removed. */
export function applyEvent(state, type, data) {
  switch (type) {
    case 'tunnel':
    case 'added': {
      const tunnels = { ...state.tunnels, [data.name]: data.tunnel };
      const logs = state.logs[data.name] ? state.logs : { ...state.logs, [data.name]: [] };
      return { ...state, tunnels, logs };
    }
    case 'log': {
      const current = state.logs[data.name] ?? [];
      const next = current.length >= MAX_LOGS
        ? [...current.slice(current.length - MAX_LOGS + 1), data.event]
        : [...current, data.event];
      return { ...state, logs: { ...state.logs, [data.name]: next } };
    }
    case 'removed': {
      const tunnels = { ...state.tunnels };
      const logs = { ...state.logs };
      delete tunnels[data.name];
      delete logs[data.name];
      return { ...state, tunnels, logs, selected: keepSelection(state, tunnels) };
    }
    default:
      return state;
  }
}

/** Running means a connector is (or is about to be) up; stopped and errored tunnels are not. */
export function isRunning(t) {
  return t.state !== 'stopped' && t.state !== 'error';
}

/** Tunnels matching the search box and the All/Running/Stopped filter, sorted by name. */
export function visibleTunnels(state) {
  const q = state.filter.trim().toLowerCase();
  return sortedNames(state.tunnels)
    .map((n) => state.tunnels[n])
    .filter((t) => state.show === 'running' ? isRunning(t) : state.show === 'stopped' ? !isRunning(t) : true)
    .filter((t) => !q
      || t.name.toLowerCase().includes(q)
      || t.config.subdomain.toLowerCase().includes(q)
      || t.config.zone.toLowerCase().includes(q)
      || String(t.config.port).includes(q));
}

export function tunnelCounts(state) {
  const all = Object.values(state.tunnels);
  const running = all.filter(isRunning).length;
  return { total: all.length, running, stopped: all.length - running };
}

/** Colour family for a tunnel state: ok | warn | danger | muted. */
export function stateTone(state) {
  switch (state) {
    case 'connected': return 'ok';
    case 'connecting':
    case 'restarting':
    case 'creating': return 'warn';
    case 'error':
    case 'port_down':
    case 'disconnected': return 'danger';
    default: return 'muted';
  }
}

export const stateLabel = (state) => state.replace('_', ' ');

export function formatUptime(connectedAt, now = Date.now()) {
  if (!connectedAt) return '—';
  const s = Math.max(0, Math.floor((now - connectedAt) / 1000));
  const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

// -- Routes: #/ (overview), #/new, #/settings, #/tunnel/<name> -------------------

export function parseRoute(hash) {
  const path = String(hash ?? '').replace(/^#\/?/, '');
  if (path === 'new' || path === 'settings') return { view: path };
  const m = /^tunnel\/(.+)$/.exec(path);
  if (m) return { view: 'tunnel', name: decodeURIComponent(m[1]) };
  return { view: 'overview' };
}

export function routeHash(route) {
  if (route.view === 'tunnel') return `#/tunnel/${encodeURIComponent(route.name)}`;
  if (route.view === 'new' || route.view === 'settings') return `#/${route.view}`;
  return '#/';
}

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Client-side mirror of the server's tunnel validation. */
export function validateTunnelForm({ port, subdomain, zone, protocol }) {
  const errors = {};
  const portStr = String(port ?? '').trim();
  const portNum = /^\d+$/.test(portStr) ? Number(portStr) : NaN;
  if (!(portNum >= 1 && portNum <= 65535)) errors.port = 'Port must be 1–65535.';
  const sub = String(subdomain ?? '').trim().toLowerCase();
  if (!SUBDOMAIN_RE.test(sub)) errors.subdomain = 'Letters, digits and hyphens; no leading/trailing hyphen; max 63.';
  if (!String(zone ?? '').trim()) errors.zone = 'Choose a zone.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { port: portNum, subdomain: sub, zone: zone.trim(), protocol } };
}

// -- Theme ---------------------------------------------------------------------

const THEMES = ['system', 'light', 'dark'];
const THEME_NAMES = { system: 'System', light: 'Light', dark: 'Dark' };

export const knownTheme = (choice) => (THEMES.includes(choice) ? choice : 'system');

/** The theme the toggle switches to next. Unknown choices count as system. */
export function nextTheme(choice) {
  return THEMES[(THEMES.indexOf(knownTheme(choice)) + 1) % THEMES.length];
}

export function themeLabel(choice) {
  return THEME_NAMES[knownTheme(choice)];
}

// -- Accent colour ---------------------------------------------------------------

export const DEFAULT_ACCENT_HUE = 292;

export const ACCENT_PRESETS = [
  { name: 'Purple', hue: 292 },
  { name: 'Indigo', hue: 270 },
  { name: 'Blue', hue: 250 },
  { name: 'Teal', hue: 195 },
  { name: 'Green', hue: 150 },
  { name: 'Amber', hue: 70 },
  { name: 'Orange', hue: 45 },
  { name: 'Red', hue: 25 },
  { name: 'Pink', hue: 350 },
];

/** OKLCH (lightness 0–1, chroma, hue in degrees) to a #rrggbb sRGB colour, clamped to the gamut. */
export function oklchToHex(l, c, h) {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return '#' + linear.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    const srgb = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255).toString(16).padStart(2, '0');
  }).join('');
}

/** The light-theme accent for a hue, matching --accent in styles.css. */
export const accentHex = (hue) => oklchToHex(0.55, 0.21, hue);

/**
 * Standalone SVG for the icon or logo (from brand.js), for the favicon.
 * Accent parts get `accent`; the rest is dark ink that turns light on dark tab bars.
 */
export function brandSvg(art, accent) {
  const paths = art.parts.map(([isAccent, evenodd, d]) => {
    const rule = evenodd ? ' fill-rule="evenodd"' : '';
    return isAccent ? `<path fill="${accent}"${rule} d="${d}"/>` : `<path class="ink"${rule} d="${d}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${art.viewBox}">`
    + '<style>.ink{fill:#1d1b22}@media (prefers-color-scheme: dark){.ink{fill:#f2f1f5}}</style>'
    + `${paths}</svg>`;
}
