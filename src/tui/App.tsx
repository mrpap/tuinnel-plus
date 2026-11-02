import React, { useReducer, useEffect } from 'react';
import { Box, Text, useInput, useStdin, useStdout, useApp } from 'ink';
import { ThemeProvider } from '@inkjs/ui';
import { spawn as spawnChild } from 'child_process';
import { platform } from 'os';
import type { TunnelRuntime } from '../types.js';
import type { TunnelBackend } from '../services/backend.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { readConfig, writeConfig, getDefaultConfig, configExists } from '../config/store.js';
import { Sidebar, filterTunnelNames } from './Sidebar.js';
import { MainPanel } from './MainPanel.js';
import { MAX_VISIBLE, filterConnectionEvents } from './LogView.js';
import { createStateBatcher } from './batch.js';
import { HelpBar } from './HelpBar.js';
import { EmptyState } from './EmptyState.js';
import { AddWizard } from './AddWizard.js';
import { DeleteConfirm } from './DeleteConfirm.js';
import { EditForm } from './EditForm.js';
import { CommandPalette, type PaletteCommand } from './CommandPalette.js';
import { OnboardingWizard } from './OnboardingWizard.js';
import { useMetrics } from './hooks/useMetrics.js';
import { tuinnelTheme } from './theme.js';

// -- State --

export type AppMode = 'onboarding' | 'empty' | 'dashboard' | 'quitting';
type ModalType = null | 'add' | 'edit' | 'delete' | 'palette';
type TabName = 'details' | 'logs' | 'metrics';

export interface AppState {
  mode: AppMode;
  tunnels: Map<string, TunnelRuntime>;
  selectedTunnel: string | null;
  focusedPanel: 'sidebar' | 'main';
  activeModal: ModalType;
  activeTab: TabName;
  showHelp: boolean;
  notification: string | null;
  // Logs tab view state
  logFilter: string | null;      // null = no filter; '' = filter box open but empty
  logFilterEditing: boolean;     // true while typing captures keystrokes
  logScrollOffset: number;       // lines scrolled up from the live tail (0 = bottom)
  // Sidebar search state
  sidebarFilter: string | null;      // null = search closed; string = query
  sidebarFilterEditing: boolean;     // true while the search box captures keys
  sidebarSearchReturn: string | null; // selection to restore if search is cancelled
}

// -- Actions --

type Action =
  | { type: 'SET_MODE'; mode: AppMode }
  | { type: 'UPDATE_TUNNEL'; name: string; update: Partial<TunnelRuntime> }
  | { type: 'UPDATE_TUNNELS'; updates: Map<string, Partial<TunnelRuntime>> }
  | { type: 'ADD_TUNNEL'; name: string; tunnel: TunnelRuntime }
  | { type: 'REMOVE_TUNNEL'; name: string }
  | { type: 'SELECT_TUNNEL'; name: string }
  | { type: 'FOCUS_PANEL'; panel: 'sidebar' | 'main' }
  | { type: 'SET_MODAL'; modal: ModalType }
  | { type: 'SET_TAB'; tab: TabName }
  | { type: 'TOGGLE_HELP' }
  | { type: 'SET_NOTIFICATION'; message: string }
  | { type: 'CLEAR_NOTIFICATION' }
  | { type: 'START_LOG_FILTER' }
  | { type: 'UPDATE_LOG_FILTER'; value: string }
  | { type: 'CONFIRM_LOG_FILTER' }
  | { type: 'CLEAR_LOG_FILTER' }
  | { type: 'SET_LOG_SCROLL'; offset: number }
  | { type: 'START_SIDEBAR_SEARCH' }
  | { type: 'UPDATE_SIDEBAR_FILTER'; value: string }
  | { type: 'CONFIRM_SIDEBAR_SEARCH' }
  | { type: 'CANCEL_SIDEBAR_SEARCH' }
  | { type: 'TICK' };

// Fields that reset whenever the logs view context changes (tab/tunnel switch).
const RESET_LOG_VIEW = {
  logFilter: null,
  logFilterEditing: false,
  logScrollOffset: 0,
} satisfies Partial<AppState>;

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_MODE':
      return { ...state, mode: action.mode };

    case 'UPDATE_TUNNEL': {
      const tunnels = new Map(state.tunnels);
      const existing = tunnels.get(action.name);
      if (existing) {
        tunnels.set(action.name, { ...existing, ...action.update });
      }
      return { ...state, tunnels };
    }

    case 'UPDATE_TUNNELS': {
      // Apply a coalesced batch of updates in a single new map (one re-render).
      const tunnels = new Map(state.tunnels);
      for (const [name, update] of action.updates) {
        const existing = tunnels.get(name);
        if (existing) {
          tunnels.set(name, { ...existing, ...update });
        }
      }
      return { ...state, tunnels };
    }

    case 'ADD_TUNNEL': {
      const tunnels = new Map(state.tunnels);
      tunnels.set(action.name, action.tunnel);
      const mode: AppMode = 'dashboard';
      return {
        ...state,
        tunnels,
        selectedTunnel: action.name,
        mode,
      };
    }

    case 'REMOVE_TUNNEL': {
      const tunnels = new Map(state.tunnels);
      tunnels.delete(action.name);
      // Select next available tunnel
      const keys = Array.from(tunnels.keys());
      const newSelected = keys.length > 0 ? keys[0] : null;
      const mode: AppMode = tunnels.size === 0 ? 'empty' : state.mode;
      return {
        ...state,
        tunnels,
        selectedTunnel: newSelected,
        mode,
      };
    }

    case 'SELECT_TUNNEL':
      // A different tunnel has its own log buffer — reset the logs view.
      return { ...state, selectedTunnel: action.name, ...RESET_LOG_VIEW };

    case 'FOCUS_PANEL':
      return { ...state, focusedPanel: action.panel };

    case 'SET_MODAL':
      return { ...state, activeModal: action.modal };

    case 'SET_TAB':
      // Switching tabs starts the logs view fresh.
      return { ...state, activeTab: action.tab, ...RESET_LOG_VIEW };

    case 'TOGGLE_HELP':
      return { ...state, showHelp: !state.showHelp };

    case 'SET_NOTIFICATION':
      return { ...state, notification: action.message };

    case 'CLEAR_NOTIFICATION':
      return { ...state, notification: null };

    case 'START_LOG_FILTER':
      // Open an empty filter box and capture subsequent keystrokes.
      return { ...state, logFilter: '', logFilterEditing: true, logScrollOffset: 0 };

    case 'UPDATE_LOG_FILTER':
      return { ...state, logFilter: action.value };

    case 'CONFIRM_LOG_FILTER':
      // Keep the filter applied but stop capturing keys. An empty filter
      // collapses back to "no filter" so the indicator disappears.
      return {
        ...state,
        logFilterEditing: false,
        logFilter: state.logFilter === '' ? null : state.logFilter,
      };

    case 'CLEAR_LOG_FILTER':
      return { ...state, logFilter: null, logFilterEditing: false };

    case 'SET_LOG_SCROLL':
      return { ...state, logScrollOffset: Math.max(0, action.offset) };

    case 'START_SIDEBAR_SEARCH':
      return {
        ...state,
        sidebarFilter: '',
        sidebarFilterEditing: true,
        sidebarSearchReturn: state.selectedTunnel,
      };

    case 'UPDATE_SIDEBAR_FILTER': {
      const names = Array.from(state.tunnels.keys());
      const matches = filterTunnelNames(names, action.value);
      // Selection follows the matches: keep the current one if it still
      // matches, otherwise jump to the first match.
      const selected = state.selectedTunnel && matches.includes(state.selectedTunnel)
        ? state.selectedTunnel
        : (matches[0] ?? state.selectedTunnel);
      return { ...state, sidebarFilter: action.value, selectedTunnel: selected };
    }

    case 'CONFIRM_SIDEBAR_SEARCH':
      // Keep the highlighted selection; restore the full list.
      return { ...state, sidebarFilter: null, sidebarFilterEditing: false, sidebarSearchReturn: null };

    case 'CANCEL_SIDEBAR_SEARCH':
      // Restore the selection that was active before the search opened.
      return {
        ...state,
        sidebarFilter: null,
        sidebarFilterEditing: false,
        selectedTunnel: state.sidebarSearchReturn ?? state.selectedTunnel,
        sidebarSearchReturn: null,
      };

    case 'TICK':
      return { ...state };

    default:
      return state;
  }
}

// -- Props --

export interface AppProps {
  tunnelService: TunnelBackend;
  zones: Array<{ id: string; name: string }>;
  defaultZone: string;
  onShutdown: () => Promise<void>;
  /** Called after onboarding wrote the token to config (the TUI reloads the service). */
  onOnboardingComplete?: () => Promise<void>;
  initialMode?: AppMode;
}

// -- Component --

export function App({ tunnelService, zones, defaultZone, onShutdown, onOnboardingComplete, initialMode }: AppProps) {
  const { exit } = useApp();
  const { isRawModeSupported, setRawMode } = useStdin();
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;

  const initialTunnels = tunnelService.getAll();
  const tunnelNames = Array.from(initialTunnels.keys());

  const computedMode: AppMode = initialMode
    ?? (initialTunnels.size === 0 ? 'empty' : 'dashboard');

  const initialState: AppState = {
    mode: computedMode,
    tunnels: initialTunnels,
    selectedTunnel: tunnelNames[0] ?? null,
    focusedPanel: 'sidebar',
    activeModal: null,
    activeTab: 'details',
    showHelp: false,
    notification: null,
    logFilter: null,
    logFilterEditing: false,
    logScrollOffset: 0,
    sidebarFilter: null,
    sidebarFilterEditing: false,
    sidebarSearchReturn: null,
  };

  const [state, dispatch] = useReducer(reducer, initialState);

  // Bun workaround: keep process alive via raw mode
  useEffect(() => {
    if (isRawModeSupported) setRawMode(true);
    return () => { setRawMode(false); };
  }, []);

  // TunnelService event listeners.
  // stateChange fires once per cloudflared log line, so it is coalesced through
  // a throttled batcher — a burst of lines becomes one re-render. Structural
  // events (added/removed) stay immediate.
  useEffect(() => {
    const STATE_FLUSH_MS = 120;
    const batcher = createStateBatcher<Partial<TunnelRuntime>>(
      (batch) => dispatch({ type: 'UPDATE_TUNNELS', updates: batch }),
      (flush) => {
        const id = setTimeout(flush, STATE_FLUSH_MS);
        return () => clearTimeout(id);
      },
    );
    const onStateChange = ({ name, tunnel }: { name: string; state: string; tunnel: TunnelRuntime }) => {
      batcher.push(name, tunnel);
    };
    const onAdded = ({ name, tunnel }: { name: string; tunnel: TunnelRuntime }) => {
      dispatch({ type: 'ADD_TUNNEL', name, tunnel });
    };
    const onRemoved = ({ name }: { name: string }) => {
      dispatch({ type: 'REMOVE_TUNNEL', name });
    };
    tunnelService.on('stateChange', onStateChange);
    tunnelService.on('tunnelAdded', onAdded);
    tunnelService.on('tunnelRemoved', onRemoved);
    return () => {
      tunnelService.off('stateChange', onStateChange);
      tunnelService.off('tunnelAdded', onAdded);
      tunnelService.off('tunnelRemoved', onRemoved);
      batcher.dispose();
    };
  }, [tunnelService]);

  // Uptime auto-refresh: force re-render every second in dashboard mode
  useEffect(() => {
    if (state.mode !== 'dashboard') return;
    const id = setInterval(() => dispatch({ type: 'TICK' }), 1000);
    return () => clearInterval(id);
  }, [state.mode]);

  // Clear notification after 2 seconds
  useEffect(() => {
    if (state.notification) {
      const timer = setTimeout(() => {
        dispatch({ type: 'CLEAR_NOTIFICATION' });
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [state.notification]);

  const tunnelKeys = Array.from(state.tunnels.keys());
  const selectedIndex = state.selectedTunnel
    ? tunnelKeys.indexOf(state.selectedTunnel)
    : -1;

  const selectedRuntime = state.selectedTunnel
    ? state.tunnels.get(state.selectedTunnel) ?? null
    : null;

  // Prometheus metrics scraping
  const metricsAddr = selectedRuntime?.metricsPort
    ? `127.0.0.1:${selectedRuntime.metricsPort}`
    : null;
  const { metrics } = useMetrics(metricsAddr);

  // -- Modal callbacks --

  const handleAddSubmit = async (config: { port: number; subdomain: string; zone: string }) => {
    dispatch({ type: 'SET_MODAL', modal: null });
    try {
      const name = await tunnelService.create(config);
      await tunnelService.start(name);
      dispatch({ type: 'SET_NOTIFICATION', message: `Tunnel "${name}" created and started` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: 'SET_NOTIFICATION', message: `Error: ${msg}` });
    }
  };

  const handleEditSubmit = async (changes: { port: number; subdomain: string; zone: string }) => {
    if (!state.selectedTunnel) return;
    dispatch({ type: 'SET_MODAL', modal: null });
    try {
      await tunnelService.update(state.selectedTunnel, changes);
      dispatch({ type: 'SET_NOTIFICATION', message: `Tunnel "${state.selectedTunnel}" updated` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: 'SET_NOTIFICATION', message: `Error: ${msg}` });
    }
  };

  const handleDeleteConfirm = async () => {
    if (!state.selectedTunnel) return;
    const name = state.selectedTunnel;
    dispatch({ type: 'SET_MODAL', modal: null });
    try {
      await tunnelService.delete(name);
      dispatch({ type: 'SET_NOTIFICATION', message: `Tunnel "${name}" deleted` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: 'SET_NOTIFICATION', message: `Error: ${msg}` });
    }
  };

  const handleModalCancel = () => {
    dispatch({ type: 'SET_MODAL', modal: null });
  };

  const handlePaletteExecute = (id: string) => {
    // Modal-opening commands swap the palette for the target modal.
    if (id === 'add' || id === 'edit' || id === 'delete') {
      dispatch({ type: 'SET_MODAL', modal: id });
      return;
    }
    // Everything else closes the palette and acts immediately.
    dispatch({ type: 'SET_MODAL', modal: null });
    const name = state.selectedTunnel;
    const notifyError = (err: unknown) =>
      dispatch({ type: 'SET_NOTIFICATION', message: `Error: ${err instanceof Error ? err.message : String(err)}` });
    switch (id) {
      case 'toggle': {
        if (name && selectedRuntime) {
          const isRunning = selectedRuntime.state === 'connected' || selectedRuntime.state === 'connecting';
          (isRunning ? tunnelService.stop(name) : tunnelService.start(name)).catch(notifyError);
        }
        break;
      }
      case 'restart':
        if (name) tunnelService.restart(name).catch(notifyError);
        break;
      case 'copy':
        if (selectedRuntime?.publicUrl) {
          const copied = copyToClipboard(selectedRuntime.publicUrl);
          dispatch({ type: 'SET_NOTIFICATION', message: copied ? `Copied: ${selectedRuntime.publicUrl}` : 'Clipboard not available' });
        }
        break;
      case 'open':
        if (selectedRuntime?.publicUrl) {
          try {
            const cmd = platform() === 'darwin' ? 'open' : 'xdg-open';
            spawnChild(cmd, [selectedRuntime.publicUrl], { stdio: 'ignore', detached: true }).unref();
          } catch {}
        }
        break;
      case 'tab-details': dispatch({ type: 'SET_TAB', tab: 'details' }); break;
      case 'tab-logs': dispatch({ type: 'SET_TAB', tab: 'logs' }); break;
      case 'tab-metrics': dispatch({ type: 'SET_TAB', tab: 'metrics' }); break;
      case 'quit': dispatch({ type: 'SET_MODE', mode: 'quitting' }); break;
    }
  };

  const handleOnboardingComplete = async (onboardingConfig: { apiToken: string; defaultZone: string; accountId: string }) => {
    const config = configExists() ? readConfig() ?? getDefaultConfig() : getDefaultConfig();
    config.apiToken = onboardingConfig.apiToken;
    if (onboardingConfig.defaultZone) {
      config.defaultZone = onboardingConfig.defaultZone;
    }
    writeConfig(config);
    await onOnboardingComplete?.();
    dispatch({ type: 'SET_MODE', mode: 'empty' });
  };

  const handleOnboardingCancel = () => {
    onShutdown()
      .then(() => exit())
      .catch((err) => {
        process.stderr.write(
          `Warning: Error during shutdown: ${err instanceof Error ? err.message : String(err)}\n`
        );
        exit();
      });
  };

  // -- Keyboard handling --
  useInput((input, key) => {
    // Quit confirmation mode
    if (state.mode === 'quitting') {
      if (input === 'n' || input === 'N') {
        dispatch({ type: 'SET_MODE', mode: state.tunnels.size > 0 ? 'dashboard' : 'empty' });
      } else {
        // Default YES
        onShutdown()
          .then(() => exit())
          .catch((err) => {
            process.stderr.write(
              `Warning: Error during shutdown: ${err instanceof Error ? err.message : String(err)}\n`
            );
            exit();
          });
      }
      return;
    }

    // Onboarding: let the wizard handle keys
    if (state.mode === 'onboarding') return;

    // When a modal is open, let modal handle keys
    if (state.activeModal !== null) return;

    // Help overlay
    if (state.showHelp) {
      dispatch({ type: 'TOGGLE_HELP' });
      return;
    }

    // Log filter editing: capture every keystroke into the filter box so
    // typing letters doesn't fire global shortcuts (q, a, 1/2/3, ...).
    if (state.logFilterEditing) {
      if (key.escape) {
        dispatch({ type: 'CLEAR_LOG_FILTER' });
      } else if (key.return) {
        dispatch({ type: 'CONFIRM_LOG_FILTER' });
      } else if (key.backspace || key.delete) {
        dispatch({ type: 'UPDATE_LOG_FILTER', value: (state.logFilter ?? '').slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        dispatch({ type: 'UPDATE_LOG_FILTER', value: (state.logFilter ?? '') + input });
      }
      return;
    }

    // Sidebar search editing: capture keystrokes; arrows move within matches.
    if (state.sidebarFilterEditing) {
      const matches = filterTunnelNames(Array.from(state.tunnels.keys()), state.sidebarFilter);
      const idx = state.selectedTunnel ? matches.indexOf(state.selectedTunnel) : -1;
      if (key.escape) {
        dispatch({ type: 'CANCEL_SIDEBAR_SEARCH' });
      } else if (key.return) {
        dispatch({ type: 'CONFIRM_SIDEBAR_SEARCH' });
      } else if (key.upArrow) {
        if (matches.length > 0) dispatch({ type: 'SELECT_TUNNEL', name: matches[Math.max(0, idx - 1)] });
      } else if (key.downArrow) {
        if (matches.length > 0) dispatch({ type: 'SELECT_TUNNEL', name: matches[Math.min(matches.length - 1, idx + 1)] });
      } else if (key.backspace || key.delete) {
        dispatch({ type: 'UPDATE_SIDEBAR_FILTER', value: (state.sidebarFilter ?? '').slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        dispatch({ type: 'UPDATE_SIDEBAR_FILTER', value: (state.sidebarFilter ?? '') + input });
      }
      return;
    }

    // q: quit
    if (input === 'q') {
      dispatch({ type: 'SET_MODE', mode: 'quitting' });
      return;
    }

    // a: add tunnel
    if (input === 'a') {
      dispatch({ type: 'SET_MODAL', modal: 'add' });
      return;
    }

    // Empty mode only supports q and a
    if (state.mode === 'empty') return;

    // Ctrl+K: open the command palette (before plain 'k' navigation)
    if (key.ctrl && input === 'k') {
      dispatch({ type: 'SET_MODAL', modal: 'palette' });
      return;
    }

    // 1/2/3: switch tab
    if (input === '1') {
      dispatch({ type: 'SET_TAB', tab: 'details' });
      return;
    }
    if (input === '2') {
      dispatch({ type: 'SET_TAB', tab: 'logs' });
      return;
    }
    if (input === '3') {
      dispatch({ type: 'SET_TAB', tab: 'metrics' });
      return;
    }

    // Tab: switch focus
    if (key.tab) {
      dispatch({
        type: 'FOCUS_PANEL',
        panel: state.focusedPanel === 'sidebar' ? 'main' : 'sidebar',
      });
      return;
    }

    // ?: help
    if (input === '?') {
      dispatch({ type: 'TOGGLE_HELP' });
      return;
    }

    // Sidebar search: '/' opens it when the sidebar is focused and there is
    // more than one tunnel to search through.
    if (input === '/' && state.focusedPanel === 'sidebar' && state.tunnels.size > 1) {
      dispatch({ type: 'START_SIDEBAR_SEARCH' });
      return;
    }

    // Logs tab: filter box + scroll/pause. Takes ↑↓/j/k before the tunnel
    // navigation handler when the log panel is focused.
    if (state.activeTab === 'logs') {
      if (input === '/') {
        dispatch({ type: 'START_LOG_FILTER' });
        return;
      }
      if (key.escape && state.logScrollOffset > 0) {
        dispatch({ type: 'SET_LOG_SCROLL', offset: 0 });
        return;
      }
      // A single tunnel has no sidebar, so the log panel is always focused.
      const logsFocused = state.focusedPanel === 'main' || state.tunnels.size === 1;
      if (logsFocused && selectedRuntime) {
        const total = filterConnectionEvents(selectedRuntime.connections, state.logFilter).length;
        const maxOffset = Math.max(0, total - MAX_VISIBLE);
        const cur = state.logScrollOffset;
        const clamp = (n: number) => Math.min(Math.max(0, n), maxOffset);
        if (key.upArrow || input === 'k') {
          dispatch({ type: 'SET_LOG_SCROLL', offset: clamp(cur + 1) });
          return;
        }
        if (key.downArrow || input === 'j') {
          dispatch({ type: 'SET_LOG_SCROLL', offset: clamp(cur - 1) });
          return;
        }
        if (key.pageUp) {
          dispatch({ type: 'SET_LOG_SCROLL', offset: clamp(cur + MAX_VISIBLE) });
          return;
        }
        if (key.pageDown) {
          dispatch({ type: 'SET_LOG_SCROLL', offset: clamp(cur - MAX_VISIBLE) });
          return;
        }
      }
    }

    // Navigation: up/down/j/k
    if ((key.upArrow || input === 'k') && tunnelKeys.length > 0) {
      const newIndex = Math.max(0, selectedIndex - 1);
      dispatch({ type: 'SELECT_TUNNEL', name: tunnelKeys[newIndex] });
      return;
    }
    if ((key.downArrow || input === 'j') && tunnelKeys.length > 0) {
      const newIndex = Math.min(tunnelKeys.length - 1, selectedIndex + 1);
      dispatch({ type: 'SELECT_TUNNEL', name: tunnelKeys[newIndex] });
      return;
    }

    // Sidebar-focused actions
    if (state.focusedPanel === 'sidebar' && selectedRuntime) {
      // e: edit
      if (input === 'e') {
        dispatch({ type: 'SET_MODAL', modal: 'edit' });
        return;
      }

      // d: delete
      if (input === 'd') {
        dispatch({ type: 'SET_MODAL', modal: 'delete' });
        return;
      }

      // s: start/stop toggle
      if (input === 's') {
        const isRunning = selectedRuntime.state === 'connected' || selectedRuntime.state === 'connecting';
        const name = state.selectedTunnel!;
        if (isRunning) {
          tunnelService.stop(name).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            dispatch({ type: 'SET_NOTIFICATION', message: `Error stopping: ${msg}` });
          });
        } else {
          tunnelService.start(name).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            dispatch({ type: 'SET_NOTIFICATION', message: `Error starting: ${msg}` });
          });
        }
        return;
      }

      // r: restart
      if (input === 'r') {
        const name = state.selectedTunnel!;
        tunnelService.restart(name).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          dispatch({ type: 'SET_NOTIFICATION', message: `Error restarting: ${msg}` });
        });
        return;
      }
    }

    // c: copy URL
    if (input === 'c' && selectedRuntime?.publicUrl) {
      const copied = copyToClipboard(selectedRuntime.publicUrl);
      if (copied) {
        dispatch({ type: 'SET_NOTIFICATION', message: `Copied: ${selectedRuntime.publicUrl}` });
      } else {
        dispatch({ type: 'SET_NOTIFICATION', message: 'Clipboard not available' });
      }
      return;
    }

    // o: open in browser (async to avoid blocking TUI)
    if (input === 'o' && selectedRuntime?.publicUrl) {
      try {
        const cmd = platform() === 'darwin' ? 'open' : 'xdg-open';
        spawnChild(cmd, [selectedRuntime.publicUrl], { stdio: 'ignore', detached: true }).unref();
      } catch {}
      return;
    }
  });

  const isSingleTunnel = state.tunnels.size === 1;
  const isNarrow = columns < 80;
  const tunnelList = Array.from(state.tunnels.values());
  // While searching, the sidebar shows only the matching tunnels.
  const displayedTunnels = state.sidebarFilterEditing
    ? tunnelList.filter(t => filterTunnelNames([t.name], state.sidebarFilter).length > 0)
    : tunnelList;

  // Command palette entries. Selection-dependent commands appear only when a
  // tunnel is selected; URL commands only when it has a public URL.
  const selectionRunning = selectedRuntime
    ? selectedRuntime.state === 'connected' || selectedRuntime.state === 'connecting'
    : false;
  const paletteCommands: PaletteCommand[] = [
    { id: 'add', title: 'Add tunnel' },
    ...(selectedRuntime
      ? [
          { id: 'toggle', title: selectionRunning ? 'Stop tunnel' : 'Start tunnel' },
          { id: 'restart', title: 'Restart tunnel' },
          { id: 'edit', title: 'Edit tunnel' },
          { id: 'delete', title: 'Delete tunnel' },
          ...(selectedRuntime.publicUrl
            ? [
                { id: 'copy', title: 'Copy public URL' },
                { id: 'open', title: 'Open in browser' },
              ]
            : []),
        ]
      : []),
    { id: 'tab-details', title: 'Go to Details' },
    { id: 'tab-logs', title: 'Go to Logs' },
    { id: 'tab-metrics', title: 'Go to Metrics' },
    { id: 'quit', title: 'Quit' },
  ];

  // -- Render --

  // Onboarding
  if (state.mode === 'onboarding') {
    return (
      <ThemeProvider theme={tuinnelTheme}>
        <OnboardingWizard
          onComplete={handleOnboardingComplete}
          onCancel={handleOnboardingCancel}
        />
      </ThemeProvider>
    );
  }

  // Quit confirmation
  if (state.mode === 'quitting') {
    return (
      <ThemeProvider theme={tuinnelTheme}>
        <Box flexDirection="column">
          <Text>Quit? Tunnels keep running in the background service. (Y/n)</Text>
        </Box>
      </ThemeProvider>
    );
  }

  // Help overlay
  if (state.showHelp) {
    return (
      <ThemeProvider theme={tuinnelTheme}>
        <Box flexDirection="column" padding={1}>
          <Text bold>Keyboard Shortcuts</Text>
          <Text> </Text>
          <Text>  Up/Down/j/k Navigate tunnels</Text>
          <Text>  Tab         Switch focus: sidebar / main</Text>
          <Text>  1/2/3       Switch tab: details / logs / metrics</Text>
          <Text>  a           Add tunnel</Text>
          <Text>  e           Edit selected tunnel</Text>
          <Text>  d           Delete selected tunnel</Text>
          <Text>  s           Start/Stop toggle</Text>
          <Text>  r           Restart selected tunnel</Text>
          <Text>  c           Copy public URL</Text>
          <Text>  o           Open URL in browser</Text>
          <Text>  /           Search tunnels (sidebar) / filter logs (logs tab)</Text>
          <Text>  Up/Dn/PgUp/PgDn  Scroll logs (Esc resumes live tail)</Text>
          <Text>  Ctrl+K      Command palette</Text>
          <Text>  ?           Toggle this help</Text>
          <Text>  q           Quit</Text>
          <Text>  Ctrl+C      Force quit</Text>
          <Text> </Text>
          <Text dimColor>Press any key to close</Text>
        </Box>
      </ThemeProvider>
    );
  }

  // Empty state (no tunnels)
  if (state.mode === 'empty') {
    return (
      <ThemeProvider theme={tuinnelTheme}>
        <Box flexDirection="column" width={columns} height={rows}>
          {state.activeModal === 'add' ? (
            <AddWizard
              defaultZone={defaultZone}
              zones={zones}
              onSubmit={handleAddSubmit}
              onCancel={handleModalCancel}
            />
          ) : (
            <EmptyState width={columns} height={rows - 1} />
          )}
          <HelpBar
            focusedPanel={state.focusedPanel}
            notification={state.notification}
            activeModal={state.activeModal}
            activeTab={state.activeTab}
            hasSelection={false}
            mode="empty"
          />
        </Box>
      </ThemeProvider>
    );
  }

  // Dashboard with optional modal overlays
  return (
    <ThemeProvider theme={tuinnelTheme}>
      <Box flexDirection="column" width={columns} height={rows}>
        {state.activeModal === 'add' && (
          <AddWizard
            defaultZone={defaultZone}
            zones={zones}
            onSubmit={handleAddSubmit}
            onCancel={handleModalCancel}
          />
        )}
        {state.activeModal === 'edit' && selectedRuntime && (
          <EditForm
            tunnel={{
              name: selectedRuntime.name,
              port: selectedRuntime.config.port,
              subdomain: selectedRuntime.config.subdomain,
              zone: selectedRuntime.config.zone,
            }}
            zones={zones}
            onSubmit={handleEditSubmit}
            onCancel={handleModalCancel}
          />
        )}
        {state.activeModal === 'delete' && selectedRuntime && (
          <DeleteConfirm
            tunnelName={selectedRuntime.name}
            subdomain={selectedRuntime.config.subdomain}
            zone={selectedRuntime.config.zone}
            onConfirm={handleDeleteConfirm}
            onCancel={handleModalCancel}
          />
        )}
        {state.activeModal === 'palette' && (
          <CommandPalette
            commands={paletteCommands}
            onExecute={handlePaletteExecute}
            onClose={handleModalCancel}
          />
        )}
        {state.activeModal === null && (
          <>
            <Box flexDirection="row" flexGrow={1}>
              {!isSingleTunnel && !isNarrow && (
                <Sidebar
                  tunnels={displayedTunnels}
                  selectedTunnel={state.selectedTunnel}
                  focused={state.focusedPanel === 'sidebar'}
                  height={rows - 1}
                  searchQuery={state.sidebarFilterEditing ? (state.sidebarFilter ?? '') : null}
                />
              )}
              <MainPanel
                tunnel={selectedRuntime}
                focused={state.focusedPanel === 'main' || isSingleTunnel}
                activeTab={state.activeTab}
                logFilter={state.logFilter}
                logPaused={state.logScrollOffset > 0}
                logScrollOffset={state.logScrollOffset}
                metrics={metrics}
                metricsAddr={metricsAddr}
              />
            </Box>
            <HelpBar
              focusedPanel={state.focusedPanel}
              notification={state.notification}
              activeModal={state.activeModal}
              activeTab={state.activeTab}
              hasSelection={!!selectedRuntime}
              mode="dashboard"
            />
          </>
        )}
      </Box>
    </ThemeProvider>
  );
}
