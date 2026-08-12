import { BrowserWindow, Menu, Tray, app, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { monitor } from './services/monitor'
import { getSettings } from './services/settings'
import { log } from './services/logger'
import type { AppRoute } from '../shared/types'

/**
 * Window and tray management.
 *
 * The window is frameless so the app can present its own command-centre chrome,
 * and the renderer is locked down: no Node, context isolation on, sandbox on, and
 * navigation to anywhere other than the app's own entry point is refused.
 */

const DEV_URL = process.env['GDP_DEV_SERVER_URL'] ?? null
const isDev = process.env['NODE_ENV'] === 'development'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

export function markQuitting(): void {
  quitting = true
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

function resourcePath(...parts: string[]): string {
  // Packaged builds keep resources next to the app bundle; dev runs from source.
  const candidates = [
    join(app.getAppPath(), 'resources', ...parts),
    join(process.resourcesPath ?? '', 'resources', ...parts),
    join(__dirname, '..', '..', 'resources', ...parts)
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? ''
}

function appIcon(): Electron.NativeImage {
  const path = resourcePath('icon.png')
  const image = nativeImage.createFromPath(path)
  return image.isEmpty() ? nativeImage.createEmpty() : image
}

export function createMainWindow(): BrowserWindow {
  const existing = getMainWindow()
  if (existing) {
    existing.show()
    existing.focus()
    return existing
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    frame: false,
    backgroundColor: '#05060b',
    title: 'GameDriver Pro',
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      // The renderer gets no Node and no direct Electron access — everything
      // privileged goes through the validated IPC surface in ipc.ts.
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      devTools: isDev
    }
  })

  mainWindow = window
  Menu.setApplicationMenu(null)

  window.once('ready-to-show', () => {
    window.show()
  })

  // Refuse in-page navigation anywhere except the app's own document.
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      log.warn('security', `Blocked navigation to ${url}`)
    }
  })

  // Never open a second Electron window for a link; hand https links to the
  // user's browser and drop everything else.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url)
    } else {
      log.warn('security', `Blocked window.open for ${url}`)
    }
    return { action: 'deny' }
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('renderer', `Renderer process gone: ${details.reason}`)
  })

  window.on('close', (event) => {
    // Closing to the tray is the default for a monitoring app, but it is a
    // setting the user controls, and Exit from the tray always really exits.
    if (!quitting && getSettings().minimizeToTray) {
      event.preventDefault()
      window.hide()
    }
  })

  window.on('closed', () => {
    mainWindow = null
  })

  if (DEV_URL) {
    void window.loadURL(DEV_URL)
  } else {
    void window.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }

  return window
}

export function navigateTo(route: AppRoute): void {
  const window = getMainWindow()
  if (!window) {
    const created = createMainWindow()
    created.webContents.once('did-finish-load', () => created.webContents.send('event:navigate', route))
    return
  }
  window.show()
  window.focus()
  window.webContents.send('event:navigate', route)
}

export function createTray(): Tray | null {
  if (tray) return tray
  const iconPath = resourcePath('tray.png')
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    log.warn('tray', `Tray icon missing at ${iconPath}; skipping tray.`)
    return null
  }

  tray = new Tray(image.resize({ width: 16, height: 16 }))
  tray.setToolTip('GameDriver Pro')
  refreshTrayMenu()
  tray.on('double-click', () => {
    const window = getMainWindow() ?? createMainWindow()
    window.show()
    window.focus()
  })
  return tray
}

export function refreshTrayMenu(currentGame: string | null = null): void {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    { label: 'Open GameDriver Pro', click: () => navigateTo('home') },
    { type: 'separator' },
    { label: 'Scan drivers', click: () => navigateTo('drivers') },
    { label: 'Game Boost', click: () => navigateTo('boost') },
    { label: 'Performance', click: () => navigateTo('performance') },
    { type: 'separator' },
    {
      label: monitor.running ? 'Pause monitoring' : 'Resume monitoring',
      click: () => {
        if (monitor.running) monitor.stop()
        else void monitor.start(getSettings().monitorIntervalMs)
        refreshTrayMenu(currentGame)
      }
    },
    {
      label: currentGame ? `Current game: ${currentGame}` : 'No game detected',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        markQuitting()
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

export { isDev }
