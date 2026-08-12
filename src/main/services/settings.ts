import { app } from 'electron'
import { store } from './db'
import { log, describeError } from './logger'
import type { AppSettings } from '../../shared/types'

const KEY = 'settings.v1'

export const DEFAULT_SETTINGS: AppSettings = {
  launchOnStartup: false,
  minimizeToTray: true,
  monitorIntervalMs: 1000,
  // Network-touching features default to on because they are the app's core
  // purpose, but each is individually switchable and documented in Settings.
  allowVendorLookups: true,
  allowWindowsUpdateScan: true,
  notifyDriverUpdates: true,
  notifyDriverProblems: true,
  gameDetection: true,
  developerMode: false,
  theme: 'nebula'
}

let current: AppSettings | null = null

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

/** Accept only known keys with the right types — the renderer cannot inject junk. */
function sanitise(patch: Partial<AppSettings>, base: AppSettings): AppSettings {
  const themes: AppSettings['theme'][] = ['nebula', 'ember', 'toxic']
  return {
    launchOnStartup: typeof patch.launchOnStartup === 'boolean' ? patch.launchOnStartup : base.launchOnStartup,
    minimizeToTray: typeof patch.minimizeToTray === 'boolean' ? patch.minimizeToTray : base.minimizeToTray,
    monitorIntervalMs:
      typeof patch.monitorIntervalMs === 'number' ? clamp(patch.monitorIntervalMs, 500, 10_000, base.monitorIntervalMs) : base.monitorIntervalMs,
    allowVendorLookups: typeof patch.allowVendorLookups === 'boolean' ? patch.allowVendorLookups : base.allowVendorLookups,
    allowWindowsUpdateScan:
      typeof patch.allowWindowsUpdateScan === 'boolean' ? patch.allowWindowsUpdateScan : base.allowWindowsUpdateScan,
    notifyDriverUpdates: typeof patch.notifyDriverUpdates === 'boolean' ? patch.notifyDriverUpdates : base.notifyDriverUpdates,
    notifyDriverProblems:
      typeof patch.notifyDriverProblems === 'boolean' ? patch.notifyDriverProblems : base.notifyDriverProblems,
    gameDetection: typeof patch.gameDetection === 'boolean' ? patch.gameDetection : base.gameDetection,
    developerMode: typeof patch.developerMode === 'boolean' ? patch.developerMode : base.developerMode,
    theme: patch.theme && themes.includes(patch.theme) ? patch.theme : base.theme
  }
}

export function getSettings(): AppSettings {
  if (current) return current
  const raw = store.getKv(KEY)
  if (!raw) {
    current = { ...DEFAULT_SETTINGS }
    return current
  }
  try {
    current = sanitise(JSON.parse(raw) as Partial<AppSettings>, DEFAULT_SETTINGS)
  } catch (error) {
    log.warn('settings', `Stored settings unreadable, using defaults: ${describeError(error)}`)
    current = { ...DEFAULT_SETTINGS }
  }
  return current
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = sanitise(patch, getSettings())
  current = next
  store.setKv(KEY, JSON.stringify(next))
  applyLoginItem(next.launchOnStartup)
  return next
}

function applyLoginItem(enabled: boolean): void {
  try {
    // Windows only — and never silently: this only runs when the user flips the
    // switch in Settings.
    if (process.platform !== 'win32') return
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--tray'] })
  } catch (error) {
    log.warn('settings', `Could not update login item: ${describeError(error)}`)
  }
}
