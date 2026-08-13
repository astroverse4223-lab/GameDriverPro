import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { INVOKE_CHANNELS } from '../shared/ipc'
import type { InvokeChannel } from '../shared/ipc'
import { getHardwareSnapshot } from './services/hardware'
import { getDriverInventory } from './services/drivers'
import { scanForDriverUpdates, lastScanResult, lastSourceStatuses } from './services/driverSources'
import { catalogDownloadUrls } from './services/driverSources/catalogSource'
import {
  backupDrivers,
  createRestorePoint,
  getRollbackInfo,
  installCatalogDriver,
  installVendorDriver,
  installWindowsUpdateDriver,
  openDeviceManagerFor,
  restorePointStatus
} from './services/driverActions'
import { buildHealthReport } from './services/health'
import { monitor } from './services/monitor'
import { getGameLibrary, launchGame, openGameFolder } from './services/games'
import { analyseCrashes } from './services/crashes'
import {
  applyBoost,
  buildBoostPlan,
  listPowerPlans,
  listProcesses,
  listStartupItems,
  revertBoost,
  setPowerPlan,
  setStartupEnabled
} from './services/boost'
import { runNetworkTest } from './services/network'
import { store } from './services/db'
import { getSettings, updateSettings } from './services/settings'
import { buildDiagnostics } from './services/diagnostics'
import { log, describeError } from './services/logger'
import type { GameProfile, InstallProgress } from '../shared/types'

/**
 * The privileged side of the IPC boundary.
 *
 * Every handler validates its own payload before touching the system: the
 * renderer is treated as untrusted input even though we ship it ourselves. A
 * handler that receives something unexpected throws a plain message the UI can
 * display, rather than passing the value on to PowerShell or the shell.
 */

let callsHandled = 0
let errors = 0

export function ipcStats(): { channels: number; callsHandled: number; errors: number } {
  return { channels: INVOKE_CHANNELS.length, callsHandled, errors }
}

// --- validation -------------------------------------------------------------

function asRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function reqString(payload: unknown, key: string, maxLength = 512): string {
  const value = asRecord(payload)[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Expected “${key}” to be a string of 1–${maxLength} characters.`)
  }
  return value
}

function optString(payload: unknown, key: string, maxLength = 512): string | null {
  const value = asRecord(payload)[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`Expected “${key}” to be a string of at most ${maxLength} characters.`)
  }
  return value
}

function reqBool(payload: unknown, key: string): boolean {
  const value = asRecord(payload)[key]
  if (typeof value !== 'boolean') throw new Error(`Expected “${key}” to be true or false.`)
  return value
}

function optBool(payload: unknown, key: string, fallback = false): boolean {
  const value = asRecord(payload)[key]
  return typeof value === 'boolean' ? value : fallback
}

function optNumber(payload: unknown, key: string, fallback: number, min: number, max: number): number {
  const value = asRecord(payload)[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function reqNumberArray(payload: unknown, key: string, maxItems = 200): number[] {
  const value = asRecord(payload)[key]
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    .slice(0, maxItems)
    .map((item) => Math.round(item))
}

function reqStringArray(payload: unknown, key: string, maxItems = 50): string[] {
  const value = asRecord(payload)[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length <= 128).slice(0, maxItems)
}

// --- registration -----------------------------------------------------------

type Handler = (payload: unknown, window: BrowserWindow | null) => Promise<unknown> | unknown

const handlers = new Map<InvokeChannel, Handler>()

function on(channel: InvokeChannel, handler: Handler): void {
  handlers.set(channel, handler)
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  // --- hardware
  on('hardware:get', () => getHardwareSnapshot(false))
  on('hardware:refresh', () => getHardwareSnapshot(true))

  // --- drivers
  on('drivers:inventory', (payload) => getDriverInventory(optBool(payload, 'refresh')))

  on('drivers:scan', async () => {
    const settings = getSettings()
    return scanForDriverUpdates({
      allowVendorLookups: settings.allowVendorLookups,
      allowWindowsUpdate: settings.allowWindowsUpdateScan,
      onProgress: (progress) => send('event:scanProgress', progress)
    })
  })

  on('drivers:rollbackInfo', (payload) => getRollbackInfo(reqString(payload, 'deviceId', 400)))
  on('drivers:openRollbackUi', (payload) => openDeviceManagerFor(reqString(payload, 'deviceId', 400)))

  on('drivers:install', async (payload) => {
    const updateId = reqString(payload, 'updateId', 200)
    const createPoint = reqBool(payload, 'createRestorePoint')
    const deviceName = reqString(payload, 'confirmedDeviceName', 300)
    const fromVersion = optString(payload, 'confirmedFromVersion', 100)
    const toVersion = optString(payload, 'confirmedToVersion', 100)

    // Only something this session actually scanned and offered can be installed,
    // and the renderer has to echo back the device name it displayed — so a
    // stale or tampered request cannot install a package the user never saw.
    const offered = lastScanResult()?.updates.find((u) => u.id === updateId)
    if (!offered) throw new Error('That update is not in the latest scan results. Run a new scan first.')
    if (offered.deviceName !== deviceName) {
      throw new Error('The confirmation did not match the update on screen. Nothing was installed.')
    }

    const onProgress = (progress: InstallProgress) => send('event:installProgress', progress)

    if (offered.action === 'catalog-install') {
      return installCatalogDriver({
        update: offered,
        createRestorePoint: createPoint,
        onProgress,
        resolveUrls: catalogDownloadUrls
      })
    }

    if (offered.action === 'vendor-install') {
      return installVendorDriver({
        update: offered,
        createRestorePoint: createPoint,
        cleanInstall: optBool(payload, 'cleanInstall'),
        silent: optBool(payload, 'silent', true),
        onProgress
      })
    }

    if (offered.action !== 'install') {
      throw new Error(
        'This item is not installable by GameDriver Pro — use the official manufacturer page shown on the card.'
      )
    }

    const match = /^wu:([0-9a-fA-F-]{36}):(\d+)$/.exec(updateId)
    if (!match) throw new Error('Malformed Windows Update identity.')

    return installWindowsUpdateDriver({
      updateId: match[1] ?? '',
      revision: Number(match[2] ?? '0'),
      deviceName,
      fromVersion,
      toVersion,
      createRestorePoint: createPoint,
      onProgress
    })
  })

  on('drivers:backup', (payload) => backupDrivers(reqString(payload, 'destination', 400)))

  on('drivers:pickBackupFolder', async (_payload, window) => {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose where to export driver packages',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Back up here'
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // --- system
  on('system:createRestorePoint', (payload) => createRestorePoint(reqString(payload, 'description', 220)))
  on('system:restorePointStatus', () => restorePointStatus())

  // --- health
  on('health:report', () => buildHealthReport())

  // --- monitor
  on('monitor:start', async () => {
    const settings = getSettings()
    const capabilities = await monitor.start(settings.monitorIntervalMs)
    return capabilities
  })
  on('monitor:stop', () => {
    monitor.stop()
  })
  on('monitor:capabilities', () => monitor.getCapabilities())

  // --- games
  on('games:list', (payload) => {
    if (!getSettings().gameDetection) {
      return { capturedAt: Date.now(), games: [], launchers: [], warnings: ['Game detection is turned off in Settings.'] }
    }
    return getGameLibrary(optBool(payload, 'refresh'))
  })
  on('games:launch', (payload) => launchGame(reqString(payload, 'gameId', 300)))
  on('games:openFolder', (payload) => openGameFolder(reqString(payload, 'gameId', 300)))
  on('games:profileGet', (payload) => store.getProfile(reqString(payload, 'gameId', 300)))
  on('games:profileSave', (payload) => {
    const record = asRecord(payload)
    const profile: GameProfile = {
      gameId: reqString(payload, 'gameId', 300),
      name: reqString(payload, 'name', 300),
      powerPlan: optString(payload, 'powerPlan', 64),
      closeApps: reqStringArray(payload, 'closeApps'),
      pauseNotifications: typeof record['pauseNotifications'] === 'boolean' ? record['pauseNotifications'] : false,
      startMonitoring: typeof record['startMonitoring'] === 'boolean' ? record['startMonitoring'] : true,
      notes: optString(payload, 'notes', 2000) ?? '',
      updatedAt: Date.now()
    }
    store.saveProfile(profile)
  })

  // --- crashes
  on('crashes:analyze', (payload) => analyseCrashes(optNumber(payload, 'windowDays', 30, 1, 365)))

  // --- boost
  on('boost:plan', () => buildBoostPlan())
  on('boost:apply', (payload) =>
    applyBoost(reqStringArray(payload, 'actionIds'), reqNumberArray(payload, 'closePids'), optString(payload, 'powerPlanGuid', 64))
  )
  on('boost:revert', (payload) => revertBoost(reqString(payload, 'token', 64)))

  // --- processes / startup / power
  on('processes:list', () => listProcesses())
  on('startup:list', () => listStartupItems())
  on('startup:setEnabled', (payload) =>
    setStartupEnabled(reqString(payload, 'name', 260), reqString(payload, 'location', 400), reqBool(payload, 'enabled'))
  )
  on('power:plans', () => listPowerPlans())
  on('power:setPlan', (payload) => setPowerPlan(reqString(payload, 'guid', 64)))

  // --- network
  on('network:test', () => runNetworkTest())

  // --- history / settings / diagnostics
  on('history:list', (payload) => store.listHistory(optNumber(payload, 'limit', 200, 1, 2000)))
  on('history:clear', () => {
    store.clearHistory()
  })
  on('settings:get', () => getSettings())
  on('settings:set', (payload) => {
    const next = updateSettings(asRecord(payload))
    if (monitor.running) {
      monitor.stop()
      void monitor.start(next.monitorIntervalMs)
    }
    return next
  })
  on('diagnostics:get', () => buildDiagnostics(lastSourceStatuses(), ipcStats()))

  // --- app
  on('app:openExternal', async (payload) => {
    const url = reqString(payload, 'url', 2048)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, message: 'That is not a valid link.' }
    }
    // Only web links and the game-launcher protocols are ever handed to the OS.
    const allowedProtocols = ['https:', 'http:', 'steam:', 'com.epicgames.launcher:', 'uplay:', 'battlenet:', 'goggalaxy:']
    if (!allowedProtocols.includes(parsed.protocol)) {
      return { ok: false, message: `GameDriver Pro will not open “${parsed.protocol}” links.` }
    }
    try {
      await shell.openExternal(url)
      return { ok: true, message: 'Opened in your browser.' }
    } catch (error) {
      return { ok: false, message: describeError(error) }
    }
  })

  on('app:openPath', async (payload) => {
    const path = reqString(payload, 'path', 1024)
    const error = await shell.openPath(path)
    return error ? { ok: false, message: error } : { ok: true, message: 'Opened.' }
  })

  on('app:windowControl', (payload, window) => {
    const action = reqString(payload, 'action', 16)
    if (!window || window.isDestroyed()) return
    if (action === 'minimize') window.minimize()
    else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize()
    else if (action === 'close') window.close()
  })

  on('app:relaunch', async () => {
    const { app } = await import('electron')
    app.relaunch()
    app.exit(0)
  })

  // Bind every registered handler behind one wrapper that logs, counts and
  // converts thrown errors into a message the UI can show without crashing.
  for (const channel of INVOKE_CHANNELS) {
    const handler = handlers.get(channel)
    if (!handler) {
      log.error('ipc', `No handler registered for ${channel}`)
      continue
    }
    ipcMain.handle(channel, async (event, payload: unknown) => {
      callsHandled += 1
      const window = BrowserWindow.fromWebContents(event.sender)
      try {
        return await handler(payload, window)
      } catch (error) {
        errors += 1
        const message = describeError(error)
        log.warn('ipc', `${channel} failed: ${message}`)
        throw new Error(message)
      }
    })
  }

  // Relay live telemetry to whichever window is open.
  monitor.subscribe((sample) => send('event:monitorSample', sample))

  log.info('ipc', `Registered ${handlers.size}/${INVOKE_CHANNELS.length} channels`)
}
