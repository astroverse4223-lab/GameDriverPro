import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../shared/ipc'
import type { EventChannel, GdpApi, InvokeChannel } from '../shared/ipc'

/**
 * The only bridge between the sandboxed UI and Windows.
 *
 * Nothing here takes a channel name from the caller: every function below is
 * bound to a literal channel from the shared allow-list, so a compromised
 * renderer cannot reach an arbitrary ipcMain handler.
 */

const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const eventAllowed = new Set<string>(EVENT_CHANNELS)

function invoke<T>(channel: InvokeChannel, payload?: unknown): Promise<T> {
  if (!invokeAllowed.has(channel)) {
    return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
  }
  return ipcRenderer.invoke(channel, payload) as Promise<T>
}

function subscribe<T>(channel: EventChannel, cb: (payload: T) => void): () => void {
  if (!eventAllowed.has(channel)) return () => {}
  const listener = (_e: unknown, payload: T) => {
    try {
      cb(payload)
    } catch {
      /* a throwing UI callback must never take down the bridge */
    }
  }
  ipcRenderer.on(channel, listener as never)
  return () => ipcRenderer.removeListener(channel, listener as never)
}

const api: GdpApi = {
  hardware: {
    get: () => invoke('hardware:get'),
    refresh: () => invoke('hardware:refresh')
  },
  drivers: {
    inventory: (refresh) => invoke('drivers:inventory', { refresh: refresh === true }),
    scan: () => invoke('drivers:scan'),
    rollbackInfo: (deviceId) => invoke('drivers:rollbackInfo', { deviceId }),
    openRollbackUi: (deviceId) => invoke('drivers:openRollbackUi', { deviceId }),
    install: (req) => invoke('drivers:install', req),
    backup: (destination) => invoke('drivers:backup', { destination }),
    pickBackupFolder: () => invoke('drivers:pickBackupFolder')
  },
  system: {
    createRestorePoint: (description) => invoke('system:createRestorePoint', { description }),
    restorePointStatus: () => invoke('system:restorePointStatus')
  },
  health: {
    report: () => invoke('health:report')
  },
  monitor: {
    start: () => invoke('monitor:start'),
    stop: () => invoke('monitor:stop'),
    capabilities: () => invoke('monitor:capabilities')
  },
  games: {
    list: (refresh) => invoke('games:list', { refresh: refresh === true }),
    launch: (gameId) => invoke('games:launch', { gameId }),
    openFolder: (gameId) => invoke('games:openFolder', { gameId }),
    profileGet: (gameId) => invoke('games:profileGet', { gameId }),
    profileSave: (profile) => invoke('games:profileSave', profile)
  },
  crashes: {
    analyze: (windowDays) => invoke('crashes:analyze', { windowDays })
  },
  boost: {
    plan: () => invoke('boost:plan'),
    apply: (req) => invoke('boost:apply', req),
    revert: (token) => invoke('boost:revert', { token })
  },
  processes: {
    list: () => invoke('processes:list')
  },
  startup: {
    list: () => invoke('startup:list'),
    setEnabled: (req) => invoke('startup:setEnabled', req)
  },
  network: {
    test: () => invoke('network:test')
  },
  power: {
    plans: () => invoke('power:plans'),
    setPlan: (guid) => invoke('power:setPlan', { guid })
  },
  history: {
    list: (limit) => invoke('history:list', { limit: limit ?? 200 }),
    clear: () => invoke('history:clear')
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch)
  },
  diagnostics: {
    get: () => invoke('diagnostics:get')
  },
  app: {
    openExternal: (url) => invoke('app:openExternal', { url }),
    openPath: (path) => invoke('app:openPath', { path }),
    windowControl: (req) => invoke('app:windowControl', req),
    relaunch: () => invoke('app:relaunch')
  },
  on: {
    scanProgress: (cb) => subscribe('event:scanProgress', cb),
    installProgress: (cb) => subscribe('event:installProgress', cb),
    monitorSample: (cb) => subscribe('event:monitorSample', cb),
    notification: (cb) => subscribe('event:notification', cb),
    navigate: (cb) => subscribe('event:navigate', cb)
  },
  meta: {
    platform: process.platform,
    isWindows: process.platform === 'win32',
    appVersion: process.env.GDP_APP_VERSION ?? '0.0.0'
  }
}

contextBridge.exposeInMainWorld('gdp', api)
