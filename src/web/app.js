import {
  initialState, applySnapshot, applyEvent, applyLogs, needsLogHistory, visibleTunnels, tunnelCounts, isRunning,
  stateTone, stateLabel, formatUptime, parseRoute, routeHash, validateTunnelForm, knownTheme, nextTheme, themeLabel,
  ACCENT_PRESETS, DEFAULT_ACCENT_HUE, accentHex, brandSvg,
} from './state.js';
import { ICONS } from './icons.js';
import { ICON, LOGO } from './brand.js';

const PROTOCOLS = ['http', 'https'];
const MIN_PASSWORD = 8;

// -- Tiny DOM helpers --------------------------------------------------------

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build an element. Children may be strings (inserted as text, never HTML) or nodes. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** replaceChildren that skips null/false (the DOM would print them as text). */
function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

function icon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 960 960');
  svg.setAttribute('class', `icon ${extraClass}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  svg.append(path);
  return svg;
}

/** Static markup marks icons with data-icon="name". */
for (const el of document.querySelectorAll('[data-icon]')) el.prepend(icon(el.dataset.icon));

/** The tuinnel-plus icon or logo, coloured by CSS (.brand-accent / .brand-ink). */
function brandArt(art) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', art.viewBox);
  svg.setAttribute('aria-hidden', 'true');
  for (const [isAccent, evenodd, d] of art.parts) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', isAccent ? 'brand-accent' : 'brand-ink');
    if (evenodd) path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

for (const el of document.querySelectorAll('[data-logo]')) el.replaceChildren(brandArt(el.dataset.logo === 'icon' ? ICON : LOGO));

// -- Accent colour: the logo, buttons and favicon all follow it ---------------

const ACCENT_KEY = 'tp-accent';
let accentHue = DEFAULT_ACCENT_HUE;

function applyAccent(hue) {
  accentHue = hue;
  document.documentElement.style.setProperty('--hue', String(hue));
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) favicon.href = `data:image/svg+xml,${encodeURIComponent(brandSvg(ICON, accentHex(hue)))}`;
  try { localStorage.setItem(ACCENT_KEY, String(hue)); } catch { /* cached only to avoid a flash */ }
}

function toast(message, kind = 'info') {
  const el = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}` }, message);
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

function seg(options, current, onPick, cls = '') {
  return h('div', { class: `seg ${cls}`, role: 'group' }, options.map((o) => h('button', {
    type: 'button',
    'aria-pressed': String(o.value === current),
    onclick: () => onPick(o.value),
  }, o.icon ? icon(o.icon) : null, o.label, o.count !== undefined ? h('span', { class: 'count' }, o.count) : null)));
}

function switchButton(label, checked, onToggle) {
  const btn = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(checked) },
    h('span', { class: 'track' }, h('span', { class: 'knob' })), label);
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(next));
    onToggle(next);
  });
  return btn;
}

function selectBox(options, value, attrs = {}) {
  const select = h('select', { class: attrs.class ?? 'input', 'aria-label': attrs.label },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  return { select, el: h('span', { class: 'select-wrap' }, select, icon('expand_more')) };
}

function field(label, control, errorKey) {
  return h('label', { class: 'field' }, label, control,
    errorKey ? h('span', { class: 'field-error', 'data-error': errorKey }) : null);
}

// -- API ---------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  });
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) showAuth('login');
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data;
}

const tunnelPath = (name) => `/api/tunnels/${encodeURIComponent(name)}`;

let zonesCache = null;
async function zones() {
  zonesCache ??= await api('/api/zones');
  return zonesCache;
}

/** Zone names for pickers: Cloudflare's list plus any zone a tunnel already uses, so a failed lookup never leaves them empty. */
async function zoneNames() {
  let names = [];
  try {
    names = (await zones()).map((z) => z.name);
  } catch (err) {
    toast(`Could not load zones from Cloudflare: ${err.message}`, 'error');
  }
  for (const t of Object.values(state.tunnels)) if (!names.includes(t.config.zone)) names.push(t.config.zone);
  return names.sort();
}

// -- State -------------------------------------------------------------------

let state = initialState();
let route = parseRoute(location.hash);
let remoteAccess = null; // { enabled, subdomain, zone, url } from /api/settings
let version = null;

const REPO_URL = 'https://github.com/mrpap/tuinnel-plus';
let events = null;
const busy = new Set();
/** The mounted view: update() refreshes its live parts, unmount() stops its timers. */
let view = { update: null, unmount: null };

function setState(next) {
  state = next;
  render();
}

function go(next) {
  const hash = routeHash(next);
  if (location.hash === hash) mountView();
  else location.hash = hash;
}

window.addEventListener('hashchange', () => {
  route = parseRoute(location.hash);
  mountView();
  window.scrollTo(0, 0);
});

// -- Auth screens ------------------------------------------------------------

let authMode = 'login';

function showAuth(mode, hint = '') {
  authMode = mode;
  closeEvents();
  $('app').hidden = true;
  $('auth').hidden = false;
  const setup = mode === 'setup';
  $('auth-title').textContent = setup ? 'Set a password' : 'Sign in';
  $('auth-hint').textContent = hint || (setup
    ? `Choose the password that protects this dashboard. At least ${MIN_PASSWORD} characters.`
    : 'Enter the dashboard password.');
  $('auth-confirm-field').hidden = !setup;
  $('auth-forgot').hidden = setup;
  $('auth-password').autocomplete = setup ? 'new-password' : 'current-password';
  $('auth-submit').textContent = setup ? 'Save password' : 'Sign in';
  $('auth-error').textContent = '';
  $('auth-password').value = '';
  $('auth-confirm').value = '';
  $('auth-password').focus();
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('auth-password').value;
  const error = $('auth-error');
  error.textContent = '';
  if (authMode === 'setup') {
    if (password.length < MIN_PASSWORD) return void (error.textContent = `Use at least ${MIN_PASSWORD} characters.`);
    if (password !== $('auth-confirm').value) return void (error.textContent = 'Passwords do not match.');
  }
  $('auth-submit').disabled = true;
  try {
    await api(authMode === 'setup' ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { password } });
    await enterApp();
  } catch (err) {
    if (err.status === 403 && authMode === 'setup') error.textContent = 'The first password must be set from the machine running tuinnel-plus (http://127.0.0.1).';
    else if (err.status === 403) error.textContent = `The service refused this sign-in: ${err.message}`;
    else if (err.status === 429) error.textContent = 'Too many attempts, try later.';
    else error.textContent = err.message;
  } finally {
    $('auth-submit').disabled = false;
  }
});

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* signed out anyway */ }
  showAuth('login');
}

// -- Live updates ------------------------------------------------------------

function setLive(ok) {
  $('live').classList.toggle('down', !ok);
  $('m-live').classList.toggle('down', !ok);
  $('live-label').textContent = ok ? 'Live' : 'Reconnecting…';
}

function closeEvents() {
  if (events) events.close();
  events = null;
}

function openEvents() {
  closeEvents();
  events = new EventSource('/api/events');
  events.onopen = () => setLive(true);
  for (const type of ['tunnel', 'log', 'added', 'removed']) {
    events.addEventListener(type, (e) => setState(applyEvent(state, type, JSON.parse(e.data))));
  }
  events.onerror = () => {
    setLive(false);
    closeEvents();
    scheduleReconnect();
  };
}

/** The stream dropped: was the session lost, or did the daemon restart? Re-check, resync, reopen. */
function scheduleReconnect() {
  setTimeout(async () => {
    try {
      const status = await api('/api/auth/status');
      if (!status.authenticated) return showAuth(status.needsPasswordSetup ? 'setup' : 'login');
      await loadSnapshot();
      openEvents();
    } catch {
      scheduleReconnect();
    }
  }, 2000);
}

async function loadSnapshot() {
  const tunnels = await api('/api/tunnels');
  setState(applySnapshot(state, tunnels));
}

async function loadLogs(name) {
  try {
    const logs = await api(`${tunnelPath(name)}/logs?limit=1000`);
    setState(applyLogs(state, name, logs));
  } catch { /* tunnel may have gone */ }
}

async function loadRemoteAccess() {
  try {
    const settings = await api('/api/settings');
    remoteAccess = settings.selfExpose;
    if (typeof settings.accentHue === 'number' && settings.accentHue !== accentHue) applyAccent(settings.accentHue);
  } catch {
    remoteAccess = null;
  }
  render();
}

async function loadVersion() {
  try {
    version = (await api('/api/status')).version;
  } catch {
    version = null;
  }
  $('version').textContent = version ? `v${version}` : '';
  if (route.view === 'settings') view.update?.();
}

async function enterApp() {
  $('auth').hidden = true;
  $('app').hidden = false;
  await loadSnapshot();
  openEvents();
  loadRemoteAccess();
  loadVersion();
  mountView();
}

// -- Actions -----------------------------------------------------------------

async function runAction(name, label, fn) {
  busy.add(name);
  render();
  try {
    // Apply the tunnel the API returns right away; SSE confirms it moments later.
    const updated = await fn();
    if (updated?.name) state = applyEvent(state, 'tunnel', { name: updated.name, tunnel: updated });
  } catch (err) {
    toast(`${label} failed: ${err.message}`, 'error');
  } finally {
    busy.delete(name);
    render();
  }
}

const startStop = (t) => isRunning(t)
  ? runAction(t.name, 'Stop', () => api(`${tunnelPath(t.name)}/stop`, { method: 'POST' }))
  : runAction(t.name, 'Start', () => api(`${tunnelPath(t.name)}/start`, { method: 'POST' }));

const restart = (t) => runAction(t.name, 'Restart', () => api(`${tunnelPath(t.name)}/restart`, { method: 'POST' }));

const hostOf = (t) => `${t.config.subdomain}.${t.config.zone}`;
const urlOf = (t) => t.publicUrl ?? `https://${hostOf(t)}`;

function dot(t, extra = '') {
  return h('span', { class: `dot ${stateTone(t.state)} ${extra}`.trim(), title: stateLabel(t.state) });
}

// -- Chrome: sidebar, mobile bar, theme --------------------------------------

const NAV = [
  { view: 'overview', label: 'Overview', icon: 'dashboard' },
  { view: 'new', label: 'New tunnel', icon: 'add_circle' },
  { view: 'settings', label: 'Settings', icon: 'settings' },
];

function navCurrent(view) {
  return route.view === view || (view === 'overview' && route.view === 'tunnel' && matchMedia('(max-width: 800px)').matches);
}

function renderChrome() {
  fill($('nav'), NAV.map((n) => h('button', {
    type: 'button', 'aria-current': navCurrent(n.view) ? 'page' : null, onclick: () => go({ view: n.view }),
  }, icon(n.icon), n.label)));
  fill($('m-nav'), NAV.map((n) => h('button', {
    type: 'button', title: n.label, 'aria-label': n.label,
    'aria-current': navCurrent(n.view) ? 'page' : null, onclick: () => go({ view: n.view }),
  }, icon(n.icon))));

  const counts = tunnelCounts(state);
  $('side-count').textContent = `${counts.running}/${counts.total}`;
  const items = visibleTunnels({ ...state, show: 'all' });
  fill($('side-list'), items.length ? items.map((t) => h('li', {
    class: 'side-item',
    tabindex: '0',
    'aria-current': route.view === 'tunnel' && route.name === t.name ? 'page' : null,
    onclick: () => go({ view: 'tunnel', name: t.name }),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go({ view: 'tunnel', name: t.name }); } },
  },
    dot(t, 'small'),
    h('span', { class: 'text' },
      h('span', { class: 'name' }, t.name),
      h('span', { class: 'sub' }, `:${t.config.port} → ${t.config.zone}`)),
  )) : h('li', { class: 'side-empty' }, Object.keys(state.tunnels).length ? 'No matches.' : 'No tunnels yet.'));
}

$('search').addEventListener('input', (e) => setState({ ...state, filter: e.target.value }));
$('signout-btn').addEventListener('click', signOut);

const THEME_KEY = 'tp-theme';
const THEME_ICONS = { system: 'contrast', light: 'light_mode', dark: 'dark_mode' };

function savedTheme() {
  try { return knownTheme(localStorage.getItem(THEME_KEY)); } catch { return 'system'; }
}

let theme = savedTheme();

function setTheme(choice) {
  theme = knownTheme(choice);
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch { /* storage blocked: applies for this visit only */ }
  applyTheme();
}

function applyTheme() {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  fill($('theme-btn'), icon(THEME_ICONS[theme]), themeLabel(theme));
  $('theme-btn').title = `Theme: ${themeLabel(theme)}`;
  fill($('m-theme'), icon(THEME_ICONS[theme]));
  $('m-theme').title = `Theme: ${themeLabel(theme)}`;
  if (route.view === 'settings') view.update?.();
}

$('theme-btn').addEventListener('click', () => setTheme(nextTheme(theme)));
$('m-theme').addEventListener('click', () => setTheme(nextTheme(theme)));
applyTheme();

// -- Views -------------------------------------------------------------------
// Each view builds its markup once (mount) and refreshes only its live parts
// (update), so typing in a form is never interrupted by incoming events.

function mountView() {
  view.unmount?.();
  const root = $('view');
  const builders = { overview: overviewView, tunnel: tunnelView, new: newTunnelView, settings: settingsView };
  if (route.view === 'tunnel' && !state.tunnels[route.name]) {
    route = { view: 'overview' };
    history.replaceState(null, '', routeHash(route));
  }
  state = { ...state, selected: route.view === 'tunnel' ? route.name : null };
  view = builders[route.view](root) ?? {};
  render();
}

function render() {
  if ($('app').hidden) return;
  if (route.view === 'tunnel' && !state.tunnels[route.name]) return go({ view: 'overview' });
  renderChrome();
  view.update?.();
}

function pageHead(title, sub, ...actions) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'titles' }, h('h1', {}, title), sub ? h('div', { class: 'page-sub' }, sub) : null),
    ...actions);
}

// Overview ------------------------------------------------------------------

function overviewView(root) {
  const sub = h('div', { class: 'page-sub' });
  const stats = h('div', { class: 'stats' });
  const filters = h('div', {});
  const rows = h('div', {});
  const search = h('input', {
    class: 'input', type: 'search', placeholder: 'Search tunnels', 'aria-label': 'Search tunnels', value: state.filter,
    oninput: (e) => { $('search').value = e.target.value; setState({ ...state, filter: e.target.value }); },
  });

  fill(root,
    h('div', { class: 'page-head' },
      h('div', { class: 'titles' }, h('h1', {}, 'Overview'), sub),
      // The phone top bar already has a New tunnel button
      h('button', { class: 'btn primary hide-narrow', type: 'button', onclick: () => go({ view: 'new' }) }, icon('add'), 'New tunnel')),
    stats,
    h('section', { class: 'card table-card' },
      h('div', { class: 'card-head' },
        h('span', { class: 'title' }, 'Tunnels'),
        h('div', { class: 'search-inline' }, icon('search'), search),
        filters),
      rows));

  const stat = (iconName, tone, label, value) => h('div', { class: 'stat' },
    h('span', { class: `stat-icon tone-${tone}` }, icon(iconName)),
    h('div', {}, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value)));

  return {
    update() {
      const counts = tunnelCounts(state);
      const zoneCount = new Set(Object.values(state.tunnels).map((t) => t.config.zone)).size;
      sub.textContent = `${counts.total} tunnel${counts.total === 1 ? '' : 's'} across ${zoneCount} zone${zoneCount === 1 ? '' : 's'}`;
      fill(stats,
        stat('bolt', 'ok', 'Running', counts.running),
        stat('pause_circle', 'muted', 'Stopped', counts.stopped),
        stat('lan', 'accent', 'Total', counts.total),
        stat('public', 'accent', 'Remote access', remoteAccess ? (remoteAccess.enabled ? 'On' : 'Off') : '—'));
      fill(filters, seg([
        { value: 'all', label: 'All', count: counts.total },
        { value: 'running', label: 'Running', count: counts.running },
        { value: 'stopped', label: 'Stopped', count: counts.stopped },
      ], state.show, (show) => setState({ ...state, show })));

      const list = visibleTunnels(state);
      fill(rows, list.length ? list.map(tunnelRow)
        : h('div', { class: 'empty' }, counts.total ? 'No tunnels match.' : 'No tunnels yet. Add one to get started.'));
    },
  };
}

function tunnelRow(t) {
  const open = () => go({ view: 'tunnel', name: t.name });
  const halt = (e) => e.stopPropagation();
  const running = isRunning(t);
  return h('div', {
    class: 'row', tabindex: '0', onclick: open,
    onkeydown: (e) => { if (e.target === e.currentTarget && e.key === 'Enter') open(); },
  },
    h('div', { class: 'who' },
      dot(t, 'ring'),
      h('div', {},
        h('div', { class: 'name' }, t.name, t.system ? h('span', { class: 'tag accent' }, 'admin UI') : null),
        h('div', { class: 'host' }, hostOf(t)))),
    h('div', { class: 'meta' },
      h('span', { class: 'tag' }, t.config.protocol.toUpperCase()),
      h('span', { class: 'port' }, `:${t.config.port}`),
      h('span', { class: 'up' }, icon('schedule'), formatUptime(t.state === 'connected' ? t.connectedAt : 0))),
    h('div', { class: 'actions' },
      h('a', { class: 'icon-btn', href: urlOf(t), target: '_blank', rel: 'noopener', title: 'Open', 'aria-label': `Open ${hostOf(t)}`, onclick: halt }, icon('open_in_new')),
      t.system ? null : h('button', {
        class: 'icon-btn', type: 'button', disabled: busy.has(t.name),
        title: running ? 'Stop' : 'Start', 'aria-label': `${running ? 'Stop' : 'Start'} ${t.name}`,
        onclick: (e) => { halt(e); startStop(t); },
      }, icon(running ? 'stop' : 'play_arrow'))));
}

// Tunnel page ----------------------------------------------------------------

function tunnelView(root) {
  const name = route.name;
  let editing = false;
  let confirmingDelete = false;
  let logPaused = false;
  let metricsTimer = null;
  let copiedTimer = null;

  const pill = h('span', { class: 'status-pill' });
  const urlLink = h('a', { target: '_blank', rel: 'noopener' });
  const copyBtn = h('button', { class: 'copy-btn', type: 'button', title: 'Copy URL' });
  const actions = h('div', { class: 'head-actions' });
  const confirmSlot = h('div', {});
  const tabsBar = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', {});

  const setCopied = (on) => fill(copyBtn, icon(on ? 'check' : 'content_copy'), on ? 'Copied' : '');
  setCopied(false);
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(urlLink.href);
      setCopied(true);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('Could not copy: the browser blocked clipboard access.', 'error');
    }
  });

  fill(root,
    h('div', { class: 'crumbs' },
      h('button', { type: 'button', onclick: () => go({ view: 'overview' }) }, 'Overview'),
      icon('chevron_right'),
      h('span', { class: 'here' }, name)),
    h('div', { class: 'tunnel-head' },
      h('div', { class: 'titles' },
        h('div', { class: 'title-line' }, h('h1', {}, name), pill),
        h('div', { class: 'url-line' }, urlLink, copyBtn)),
      actions),
    confirmSlot, tabsBar, panel);

  const TABS = [
    { id: 'details', label: 'Details', icon: 'info' },
    { id: 'logs', label: 'Logs', icon: 'terminal' },
    { id: 'metrics', label: 'Metrics', icon: 'monitoring' },
  ];

  function setTab(tab) {
    editing = false;
    setState({ ...state, tab });
    buildPanel();
  }

  // Details
  const tiles = h('div', { class: 'tiles' });
  const errorNote = h('p', { class: 'error-note' });
  const configCard = h('section', { class: 'card' });

  function renderConfig(t) {
    if (editing) return;
    fill(configCard,
      h('div', { class: 'card-head ruled' },
        h('span', { style: 'flex:1' }, 'Configuration'),
        t.system ? null : h('button', { class: 'btn', type: 'button', onclick: startEdit }, icon('edit'), 'Edit')),
      h('div', { class: 'kv' }, [
        ['Public URL', urlOf(t)],
        ['Origin', `${t.config.protocol}://localhost:${t.config.port}`],
        ['Subdomain', t.config.subdomain],
        ['Zone', t.config.zone],
      ].map(([k, v]) => h('div', { class: 'kv-row' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)))));
  }

  async function startEdit() {
    const t = state.tunnels[name];
    if (!t) return;
    if (state.tab !== 'details') setTab('details');
    editing = true;
    confirmingDelete = false;
    const zoneList = await zoneNames();
    const cfg = t.config;
    const sub = h('input', { class: 'input mono', value: cfg.subdomain, autocapitalize: 'off', spellcheck: 'false' });
    const zone = selectBox(zoneList.map((z) => ({ value: z, label: z })), cfg.zone, { label: 'Zone' });
    const port = h('input', { class: 'input mono', value: String(cfg.port), inputmode: 'numeric' });
    let protocol = cfg.protocol;
    const protoSlot = h('div', {});
    const drawProto = () => fill(protoSlot, seg(PROTOCOLS.map((p) => ({ value: p, label: p.toUpperCase() })), protocol, (p) => { protocol = p; drawProto(); }, 'tall'));
    drawProto();
    const formError = h('p', { class: 'form-error', role: 'alert' });
    const save = h('button', { class: 'btn primary', type: 'submit' }, icon('check'), 'Save changes');

    const form = h('form', { novalidate: true },
      h('div', { class: 'card-head ruled' }, 'Edit configuration'),
      h('div', { class: 'card-body' },
        h('div', { class: 'grid-fields' },
          field('Subdomain', sub, 'subdomain'),
          field('Zone', zone.el, 'zone'),
          field('Local port', port, 'port'),
          h('div', { class: 'field' }, 'Protocol', protoSlot)),
        formError),
      h('div', { class: 'card-foot' },
        h('button', { class: 'btn', type: 'button', onclick: () => { editing = false; renderConfig(state.tunnels[name]); } }, 'Cancel'),
        save));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      for (const el of form.querySelectorAll('[data-error]')) el.textContent = '';
      formError.textContent = '';
      const result = validateTunnelForm({ port: port.value, subdomain: sub.value, zone: zone.select.value, protocol });
      if (!result.ok) {
        for (const [k, msg] of Object.entries(result.errors)) form.querySelector(`[data-error="${k}"]`).textContent = msg;
        return;
      }
      const changes = {};
      for (const k of ['port', 'subdomain', 'zone', 'protocol']) if (result.value[k] !== cfg[k]) changes[k] = result.value[k];
      if (!Object.keys(changes).length) {
        editing = false;
        return renderConfig(state.tunnels[name]);
      }
      if (changes.subdomain || changes.zone) toast('Changing the hostname recreates the tunnel on Cloudflare — this can take a moment.');
      save.disabled = true;
      try {
        const updated = await api(tunnelPath(name), { method: 'PATCH', body: changes });
        editing = false;
        if (updated.name !== name) {
          state = applyEvent(state, 'removed', { name });
          state = applyEvent(state, 'added', { name: updated.name, tunnel: updated });
          go({ view: 'tunnel', name: updated.name });
        } else {
          setState(applyEvent(state, 'tunnel', { name, tunnel: updated }));
        }
      } catch (err) {
        formError.replaceChildren(icon('error'), err.message);
        save.disabled = false;
      }
    });

    fill(configCard, form);
    sub.focus();
  }

  // Logs
  const logFilter = h('input', { class: 'terminal-filter', type: 'search', placeholder: 'Filter logs', 'aria-label': 'Filter logs' });
  const pausedPill = h('span', { class: 'paused-pill', hidden: true }, 'Paused — scroll to bottom to resume');
  const logState = h('span', { class: 'state' });
  const logView = h('pre', { class: 'log-view' });
  logFilter.addEventListener('input', () => renderLogs());
  logView.addEventListener('scroll', () => {
    logPaused = logView.scrollTop + logView.clientHeight < logView.scrollHeight - 8;
    pausedPill.hidden = !logPaused;
  });

  function renderLogs() {
    const t = state.tunnels[name];
    if (!t) return;
    fill(logState, h('span', { class: `dot ${stateTone(t.state)}` }), stateLabel(t.state));
    const q = logFilter.value.trim().toLowerCase();
    const lines = (state.logs[name] ?? []).filter((e) => !q || e.message.toLowerCase().includes(q));
    fill(logView, lines.length
      ? lines.map((e) => h('div', { class: `log-line ${e.level}` },
        h('span', { class: 'ts' }, new Date(e.timestamp).toLocaleTimeString()),
        h('span', { class: 'lvl' }, e.level),
        h('span', {}, e.message)))
      : h('div', { class: 'log-empty' }, q ? 'No lines match the filter.' : 'No log lines yet.'));
    if (!logPaused) logView.scrollTop = logView.scrollHeight;
  }

  // Metrics
  const metricsBody = h('div', {});
  async function renderMetrics() {
    let m;
    try {
      m = await api(`${tunnelPath(name)}/metrics`);
    } catch (err) {
      return fill(metricsBody, h('div', { class: 'card placeholder' }, `Metrics unavailable: ${err.message}`));
    }
    if (state.tab !== 'metrics' || route.name !== name) return;
    if (!m) return fill(metricsBody, h('div', { class: 'card placeholder' }, 'Metrics appear once the tunnel is connected.'));

    const tile = (label, value) => h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value big' }, value));
    const codes = Object.entries(m.responseCodeCounts).sort(([a], [b]) => a.localeCompare(b));
    const max = Math.max(1, ...codes.map(([, n]) => n));
    fill(metricsBody,
      h('div', { class: 'tiles' },
        tile('Requests', m.totalRequests.toLocaleString()),
        tile('Errors', m.requestErrors.toLocaleString()),
        tile('In flight', String(m.concurrentRequests)),
        tile('Edge connections', String(m.haConnections)),
        tile('Latency p50 / p95', `${Math.round(m.connectLatencyMs.p50)} / ${Math.round(m.connectLatencyMs.p95)} ms`),
        tile('QUIC RTT', `${Math.round(m.quicRtt.smoothed)} ms`)),
      h('section', { class: 'card' },
        h('div', { class: 'card-head ruled' }, h('span', { style: 'flex:1' }, 'Responses by status'),
          h('span', { class: 'muted small', style: 'font-weight:400' }, 'since the tunnel started')),
        codes.length
          ? h('div', { class: 'bars' }, codes.map(([code, n]) => h('div', { class: 'bar-row' },
            h('span', { class: 'code' }, code),
            h('span', { class: 'track' }, h('span', { class: `fill ${Number(code) >= 400 ? 'err' : ''}`, style: `width:${Math.max(2, Math.round((n / max) * 100))}%` })),
            h('span', { class: 'n' }, n.toLocaleString()))))
          : h('div', { class: 'placeholder' }, 'No requests yet.'),
        h('p', { class: 'note' }, `Updated ${new Date(m.lastScrapedAt).toLocaleTimeString()}`)));
  }

  function stopMetrics() {
    if (metricsTimer) clearInterval(metricsTimer);
    metricsTimer = null;
  }

  function buildPanel() {
    stopMetrics();
    fill(tabsBar, TABS.map((tb) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(state.tab === tb.id), onclick: () => setTab(tb.id),
    }, icon(tb.icon), tb.label)));
    if (state.tab === 'logs') {
      logPaused = false;
      pausedPill.hidden = true;
      fill(panel, h('section', { class: 'terminal' },
        h('div', { class: 'terminal-head' }, icon('terminal'), h('span', { class: 'mono' }, `cloudflared · ${name}`),
          h('span', { class: 'spacer' }), pausedPill, logFilter, logState),
        logView));
      if (needsLogHistory(state, name)) loadLogs(name);
      renderLogs();
    } else if (state.tab === 'metrics') {
      fill(metricsBody, h('div', { class: 'card placeholder' }, 'Loading metrics…'));
      fill(panel, metricsBody);
      renderMetrics();
      metricsTimer = setInterval(renderMetrics, 3000);
    } else {
      fill(panel, tiles, errorNote, configCard);
      renderConfig(state.tunnels[name]);
    }
  }

  function renderHead(t) {
    const tone = stateTone(t.state);
    pill.className = `status-pill ${tone}`;
    fill(pill, h('span', { class: `dot ${tone}` }), stateLabel(t.state));
    urlLink.href = urlOf(t);
    urlLink.textContent = urlOf(t);
    const disabled = busy.has(name);
    const running = isRunning(t);
    fill(actions,
      t.system ? h('span', { class: 'tag accent' }, 'Serves this dashboard') : null,
      t.system ? null : h('button', { class: 'btn', type: 'button', disabled, onclick: () => startStop(t) },
        icon(running ? 'stop' : 'play_arrow'), running ? 'Stop' : 'Start'),
      h('button', { class: 'btn', type: 'button', disabled, onclick: () => restart(t) }, icon('restart_alt'), 'Restart'),
      t.system ? null : h('button', { class: 'btn', type: 'button', disabled, onclick: startEdit }, icon('edit'), 'Edit'),
      t.system ? null : h('button', {
        class: 'btn danger', type: 'button', disabled,
        onclick: () => { confirmingDelete = true; editing = false; render(); if (state.tab === 'details') renderConfig(t); },
      }, icon('delete'), 'Delete'));
  }

  function renderConfirm(t) {
    if (!confirmingDelete) return fill(confirmSlot);
    const del = h('button', { class: 'btn danger-solid', type: 'button' }, 'Delete tunnel');
    del.addEventListener('click', async () => {
      del.disabled = true;
      try {
        const res = await api(tunnelPath(name), { method: 'DELETE' });
        state = applyEvent(state, 'removed', { name });
        if (res.warnings.length) toast(`Removed, but Cloudflare cleanup was incomplete: ${res.warnings.join('; ')}`, 'error');
        else toast(`Deleted ${name}`);
        go({ view: 'overview' });
      } catch (err) {
        toast(`Delete failed: ${err.message}`, 'error');
        del.disabled = false;
      }
    });
    fill(confirmSlot, h('div', { class: 'banner danger', role: 'alert' },
      icon('warning'),
      h('span', { class: 'msg' }, 'Delete ', h('strong', {}, name), '? This stops the tunnel and removes ', h('strong', {}, hostOf(t)),
        ' — its Cloudflare tunnel and DNS record are deleted too.'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', type: 'button', onclick: () => { confirmingDelete = false; render(); } }, 'Cancel'),
        del)));
  }

  function renderTiles(t) {
    const tile = (iconName, label, value) => h('div', { class: 'tile' },
      h('div', { class: 'tile-label' }, icon(iconName), label), h('div', { class: 'tile-value', title: value }, value));
    fill(tiles,
      tile('lan', 'Local port', String(t.config.port)),
      tile('http', 'Protocol', t.config.protocol.toUpperCase()),
      tile('schedule', 'Uptime', formatUptime(t.state === 'connected' ? t.connectedAt : 0)),
      tile('language', 'Zone', t.config.zone),
      tile('memory', 'PID', t.pid ? String(t.pid) : '—'),
      tile('swap_vert', 'Tunnel ID', t.tunnelId ? t.tunnelId.slice(0, 8) : '—'));
    errorNote.hidden = !t.lastError;
    errorNote.textContent = t.lastError ?? '';
  }

  let lastConfigKey = '';
  buildPanel();
  if (needsLogHistory(state, name)) loadLogs(name);

  return {
    update() {
      const t = state.tunnels[name];
      if (!t) return;
      renderHead(t);
      renderConfirm(t);
      if (state.tab === 'details') {
        renderTiles(t);
        const key = JSON.stringify(t.config);
        if (key !== lastConfigKey) { lastConfigKey = key; renderConfig(t); }
      }
      if (state.tab === 'logs') renderLogs();
    },
    unmount() {
      stopMetrics();
      clearTimeout(copiedTimer);
    },
  };
}

// New tunnel -----------------------------------------------------------------

function newTunnelView(root) {
  const port = h('input', { class: 'input mono', inputmode: 'numeric', placeholder: '3000' });
  const sub = h('input', { placeholder: 'my-app', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Subdomain' });
  const zoneSelect = h('select', { 'aria-label': 'Zone' });
  let protocol = 'http';
  let startNow = true;
  const protoSlot = h('div', {});
  const drawProto = () => fill(protoSlot, seg(PROTOCOLS.map((p) => ({ value: p, label: p.toUpperCase() })), protocol, (p) => { protocol = p; drawProto(); preview(); }, 'tall'));
  drawProto();
  const previewTo = h('span', { class: 'to' });
  const previewFrom = h('span', { class: 'from' });
  const formError = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, icon('add'), 'Add tunnel');

  function preview() {
    previewTo.textContent = `https://${sub.value.trim().toLowerCase() || 'my-app'}.${zoneSelect.value || 'example.com'}`;
    previewFrom.textContent = `${protocol}://localhost:${port.value.trim() || '3000'}`;
  }
  for (const el of [port, sub, zoneSelect]) el.addEventListener('input', preview);

  const form = h('form', { novalidate: true, class: 'narrow-page' },
    pageHead('New tunnel', 'Expose a local port on a public hostname through Cloudflare.'),
    h('section', { class: 'card' },
      h('div', { class: 'card-body', style: 'gap:16px' },
        h('div', { class: 'grid-fields' },
          field('Local port', port, 'port'),
          h('div', { class: 'field' }, 'Protocol', protoSlot)),
        h('div', { class: 'field' }, 'Hostname',
          h('div', { class: 'host-input' }, sub, h('span', { class: 'select-wrap' }, zoneSelect, icon('expand_more'))),
          h('span', { class: 'field-error', 'data-error': 'subdomain' }),
          h('span', { class: 'field-error', 'data-error': 'zone' })),
        h('div', { class: 'preview' }, icon('public', 'first'), previewTo, icon('arrow_forward'), previewFrom),
        switchButton('Start it now', startNow, (on) => { startNow = on; }),
        formError),
      h('div', { class: 'card-foot' },
        h('button', { class: 'btn', type: 'button', onclick: () => go({ view: 'overview' }) }, 'Cancel'),
        submit)));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const el of form.querySelectorAll('[data-error]')) el.textContent = '';
    formError.textContent = '';
    const result = validateTunnelForm({ port: port.value, subdomain: sub.value, zone: zoneSelect.value, protocol });
    if (!result.ok) {
      for (const [k, msg] of Object.entries(result.errors)) form.querySelector(`[data-error="${k}"]`).textContent = msg;
      return;
    }
    submit.disabled = true;
    try {
      const created = await api('/api/tunnels', { method: 'POST', body: { ...result.value, start: startNow } });
      state = applyEvent(state, 'added', { name: created.name, tunnel: created });
      go({ view: 'tunnel', name: created.name });
    } catch (err) {
      formError.replaceChildren(icon('error'), err.message);
      submit.disabled = false;
    }
  });

  fill(root, form);
  zoneNames().then((list) => {
    fill(zoneSelect, list.map((z) => h('option', { value: z }, `.${z}`)));
    preview();
  });
  preview();
  port.focus();
}

// Settings -------------------------------------------------------------------

function settingsView(root) {
  const card = (iconName, title, ...body) => h('section', { class: 'card' },
    h('div', { class: 'card-head ruled' }, icon(iconName), title),
    ...body);

  // Remote access
  let exposeOn = remoteAccess?.enabled ?? false;
  const raSub = h('input', { placeholder: 'tunnels-admin', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Subdomain', value: remoteAccess?.subdomain ?? '' });
  const raZone = h('select', { 'aria-label': 'Zone' });
  const raUrl = h('p', { class: 'card-desc' });
  const raMsg = h('span', { class: 'form-ok' });
  const raError = h('p', { class: 'form-error', role: 'alert' });
  const raSave = h('button', { class: 'btn', type: 'button' }, 'Save');
  const drawUrl = () => fill(raUrl, remoteAccess?.enabled && remoteAccess.url
    ? ['Reachable at ', h('a', { href: remoteAccess.url, target: '_blank', rel: 'noopener' }, remoteAccess.url)]
    : 'Only reachable from this machine.');
  drawUrl();
  raSave.addEventListener('click', async () => {
    raError.textContent = '';
    raMsg.textContent = '';
    if (exposeOn) {
      const check = validateTunnelForm({ port: '1', subdomain: raSub.value, zone: raZone.value, protocol: 'http' });
      if (!check.ok) return void (raError.textContent = check.errors.subdomain ?? check.errors.zone);
    }
    raSave.disabled = true;
    try {
      await api('/api/settings/self-expose', {
        method: 'PUT',
        body: exposeOn ? { enabled: true, subdomain: raSub.value.trim().toLowerCase(), zone: raZone.value } : { enabled: false },
      });
      await loadRemoteAccess();
      await loadSnapshot();
      drawUrl();
      raMsg.textContent = 'Saved';
      setTimeout(() => { raMsg.textContent = ''; }, 1800);
    } catch (err) {
      raError.textContent = err.message;
    } finally {
      raSave.disabled = false;
    }
  });

  // Password
  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const repeat = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const pwMsg = h('span', { class: 'form-ok' });
  const pwError = h('p', { class: 'form-error', role: 'alert' });
  const pwBtn = h('button', { class: 'btn', type: 'button' }, 'Change password');
  pwBtn.addEventListener('click', async () => {
    pwError.textContent = '';
    pwMsg.textContent = '';
    if (!current.value || !next.value) return void (pwError.textContent = 'Fill in all fields.');
    if (next.value.length < MIN_PASSWORD) return void (pwError.textContent = `Use at least ${MIN_PASSWORD} characters.`);
    if (next.value !== repeat.value) return void (pwError.textContent = 'Passwords do not match.');
    pwBtn.disabled = true;
    try {
      await api('/api/settings/password', { method: 'POST', body: { current: current.value, next: next.value } });
      current.value = next.value = repeat.value = '';
      pwMsg.textContent = 'Password changed. Other sessions were signed out.';
    } catch (err) {
      pwError.textContent = err.message;
    } finally {
      pwBtn.disabled = false;
    }
  });

  // Appearance
  const themeSlot = h('div', {});
  const drawTheme = () => fill(themeSlot, seg(
    ['system', 'light', 'dark'].map((v) => ({ value: v, label: themeLabel(v), icon: THEME_ICONS[v] })),
    theme, (v) => setTheme(v), 'wide'));

  const accentMsg = h('span', { class: 'form-ok' });
  const hueSlider = h('input', { class: 'hue-slider', type: 'range', min: '0', max: '359', step: '1', value: String(accentHue), 'aria-label': 'Custom accent hue' });
  const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Accent colour' });
  const drawSwatches = () => fill(swatches, ACCENT_PRESETS.map((p) => h('button', {
    type: 'button', class: 'swatch', title: p.name, 'aria-label': p.name,
    'aria-pressed': String(p.hue === accentHue), style: `--swatch-hue:${p.hue}`,
    onclick: () => saveAccent(p.hue),
  })));
  let accentSave = null;
  async function saveAccent(hue) {
    applyAccent(hue);
    hueSlider.value = String(hue);
    drawSwatches();
    const mine = (accentSave = api('/api/settings/appearance', { method: 'PUT', body: { accentHue: hue } }));
    try {
      await mine;
      if (mine !== accentSave) return;
      accentMsg.textContent = 'Saved';
      setTimeout(() => { accentMsg.textContent = ''; }, 1500);
    } catch (err) {
      toast(`Could not save the accent colour: ${err.message}`, 'error');
    }
  }
  hueSlider.addEventListener('input', () => { applyAccent(Number(hueSlider.value)); drawSwatches(); });
  hueSlider.addEventListener('change', () => saveAccent(Number(hueSlider.value)));
  drawSwatches();

  const aboutVersion = h('span', { class: 'v' });

  // Maintenance
  const purgeBtn = h('button', { class: 'btn', type: 'button' }, icon('cleaning_services'), 'Clean up');
  const purgeDesc = h('div', { class: 'desc' }, 'Delete Cloudflare tunnels left behind without a local config entry.');
  const purgeSlot = h('div', { style: 'width:100%' });
  purgeBtn.addEventListener('click', async () => {
    purgeBtn.disabled = true;
    fill(purgeSlot);
    try {
      const plan = await api('/api/purge');
      if (plan.orphaned.length === 0 && plan.stalePids.length === 0) {
        purgeDesc.textContent = 'Nothing to clean up.';
        return;
      }
      const confirmBtn = h('button', { class: 'btn danger-solid', type: 'button' },
        plan.orphaned.length ? `Delete ${plan.orphaned.length} tunnel${plan.orphaned.length === 1 ? '' : 's'}` : 'Clean up');
      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        try {
          const r = await api('/api/purge', { method: 'POST', body: { ids: plan.orphaned.map((t) => t.id) } });
          const parts = [`Deleted ${r.deleted.length} orphaned tunnel${r.deleted.length === 1 ? '' : 's'}`];
          if (r.cleanedPids) parts.push(`cleaned ${r.cleanedPids} stale process entr${r.cleanedPids === 1 ? 'y' : 'ies'}`);
          purgeDesc.textContent = `${parts.join(', ')}.`;
          for (const f of r.failed) toast(`Could not delete ${f.name}: ${f.error}`, 'error');
          fill(purgeSlot);
        } catch (err) {
          toast(`Clean-up failed: ${err.message}`, 'error');
          confirmBtn.disabled = false;
        }
      });
      fill(purgeSlot,
        plan.orphaned.length
          ? h('ul', { class: 'orphans' }, plan.orphaned.map((t) => h('li', {}, `${t.name} (${t.status})`)))
          : h('p', { class: 'card-desc' }, `${plan.stalePids.length} stale process entr${plan.stalePids.length === 1 ? 'y' : 'ies'}.`),
        plan.active.length
          ? h('p', { class: 'card-desc', style: 'margin-top:8px' }, `Left alone because they are running elsewhere: ${plan.active.map((t) => t.name).join(', ')}.`)
          : null,
        h('div', { class: 'end-row', style: 'margin-top:10px' },
          h('button', { class: 'btn', type: 'button', onclick: () => fill(purgeSlot) }, 'Cancel'), confirmBtn));
    } catch (err) {
      toast(`Clean-up failed: ${err.message}`, 'error');
    } finally {
      purgeBtn.disabled = false;
    }
  });

  fill(root,
    pageHead('Settings'),
    h('div', { class: 'settings-grid' },
      card('public', 'Remote access',
        h('div', { class: 'card-body' },
          h('p', { class: 'card-desc' }, 'Expose this dashboard through its own Cloudflare tunnel, behind your password.'),
          switchButton('Expose admin UI', exposeOn, (on) => { exposeOn = on; }),
          h('div', { class: 'host-input' }, raSub, h('span', { class: 'select-wrap' }, raZone, icon('expand_more'))),
          raUrl, raError,
          h('div', { class: 'end-row' }, raMsg, raSave))),
      card('lock', 'Password',
        h('div', { class: 'card-body' },
          field('Current password', current),
          h('div', { class: 'grid-fields' }, field('New password', next), field('Repeat new password', repeat)),
          pwError,
          h('div', { class: 'end-row' }, pwMsg, pwBtn))),
      card('palette', 'Appearance', h('div', { class: 'card-body' },
        h('div', { class: 'field' }, 'Theme', themeSlot),
        h('div', { class: 'field' }, 'Accent colour', swatches, hueSlider),
        h('div', { class: 'end-row' },
          accentMsg,
          h('button', { class: 'btn', type: 'button', onclick: () => saveAccent(DEFAULT_ACCENT_HUE) }, 'Reset to purple')))),
      card('info', 'About',
        h('div', { class: 'kv' },
          h('div', { class: 'kv-row' }, h('span', { class: 'k' }, 'Version'), aboutVersion),
          h('div', { class: 'kv-row' }, h('span', { class: 'k' }, 'Source'),
            h('span', { class: 'v' }, h('a', { href: REPO_URL, target: '_blank', rel: 'noopener' }, 'github.com/mrpap/tuinnel-plus'))),
          h('div', { class: 'kv-row' }, h('span', { class: 'k' }, 'Changes'),
            h('span', { class: 'v' }, h('a', { href: `${REPO_URL}/blob/main/CHANGELOG.md`, target: '_blank', rel: 'noopener' }, 'Changelog'))))),
      card('build', 'Maintenance',
        h('div', { class: 'kv' },
          h('div', { class: 'setting-row' },
            h('div', { class: 'text' }, h('div', { class: 'label' }, 'Clean up orphans'), purgeDesc),
            purgeBtn, purgeSlot),
          h('div', { class: 'setting-row' },
            h('div', { class: 'text' }, h('div', { class: 'label' }, 'Sign out'), h('div', { class: 'desc' }, 'End this dashboard session.')),
            h('button', { class: 'btn danger', type: 'button', onclick: signOut }, icon('logout'), 'Sign out'))))));

  zoneNames().then((list) => {
    if (remoteAccess?.zone && !list.includes(remoteAccess.zone)) list.push(remoteAccess.zone);
    fill(raZone, list.map((z) => h('option', { value: z, selected: z === remoteAccess?.zone }, `.${z}`)));
  });

  return {
    update() {
      drawTheme();
      aboutVersion.textContent = version ? `tuinnel-plus v${version}` : '—';
    },
  };
}

// Keep uptimes fresh.
setInterval(() => {
  if (route.view === 'overview' || (route.view === 'tunnel' && state.tab === 'details')) render();
}, 1000);

// -- Boot --------------------------------------------------------------------

async function boot() {
  try {
    const status = await api('/api/auth/status');
    if (typeof status.accentHue === 'number') applyAccent(status.accentHue);
    if (status.needsPasswordSetup) return showAuth('setup');
    if (!status.authenticated) return showAuth('login');
    await enterApp();
  } catch (err) {
    showAuth('login', `Could not reach tuinnel-plus: ${err.message}`);
  }
}

boot();
