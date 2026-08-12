import { BrowserWindow, Notification, app, protocol, session } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, normalize } from 'node:path'
import { registerIpc } from './ipc'
import { createMainWindow, createTray, destroyTray, getMainWindow, isDev, markQuitting, navigateTo, refreshTrayMenu } from './windows'
import { allowedArtworkPaths, getGameLibrary } from './services/games'
import { getHardwareSnapshot } from './services/hardware'
import { getSettings } from './services/settings'
import { monitor } from './services/monitor'
import { store } from './services/db'
import { log, describeError } from './services/logger'
import type { AppNotification } from '../shared/types'

/**
 * Application entry point.
 *
 * Responsibilities kept here: process-level security policy, the local artwork
 * protocol, single-instance behaviour, and warming the caches the first screen
 * needs so the boot sequence reflects real work rather than a timer.
 */

const ART_SCHEME = 'gdp-art'

// Must run before `ready` for the scheme to be usable from the renderer.
protocol.registerSchemesAsPrivileged([
  {
    scheme: ART_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, bypassCSP: false }
  }
])

// Needed on Windows for toast notifications to be attributed to this app.
app.setAppUserModelId('com.gamedriverpro.app')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = getMainWindow()
    if (window) {
      window.show()
      window.focus()
    } else {
      createMainWindow()
    }
  })

  app.whenReady().then(main).catch((error) => {
    log.error('startup', `Fatal startup error: ${describeError(error)}`)
  })
}

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

/**
 * Serves game artwork that already exists in a launcher's local cache.
 *
 * The renderer can only ask for a path that the game scanner itself discovered:
 * anything not in that set is refused, so a compromised renderer cannot use this
 * to read arbitrary files.
 */
function registerArtProtocol(): void {
  protocol.handle(ART_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const raw = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const path = normalize(raw)
      const extension = extname(path).toLowerCase()
      const mime = IMAGE_MIME[extension]

      if (!mime || !allowedArtworkPaths().has(path.toLowerCase())) {
        log.warn('security', `Refused artwork request for ${path}`)
        return new Response('Not found', { status: 404 })
      }
      if (!existsSync(path) || statSync(path).size > 12 * 1024 * 1024) {
        return new Response('Not found', { status: 404 })
      }

      const data = await readFile(path)
      // Confirm the bytes really are an image before handing them to the page.
      const isJpeg = data[0] === 0xff && data[1] === 0xd8
      const isPng = data[0] === 0x89 && data[1] === 0x50
      const isWebp = data.toString('ascii', 0, 4) === 'RIFF'
      if (!isJpeg && !isPng && !isWebp) return new Response('Not found', { status: 404 })

      return new Response(data, { headers: { 'Content-Type': mime, 'Cache-Control': 'max-age=3600' } })
    } catch (error) {
      log.warn('art', `Artwork request failed: ${describeError(error)}`)
      return new Response('Error', { status: 500 })
    }
  })
}

function applySecurityPolicy(): void {
  const devServer = process.env['GDP_DEV_SERVER_URL'] ?? ''
  const devConnect = isDev && devServer ? ` ${devServer} ${devServer.replace('http://', 'ws://')}` : ''

  const csp = [
    "default-src 'none'",
    isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${ART_SCHEME}:`,
    "font-src 'self' data:",
    `connect-src 'self' data:${devConnect}`,
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "worker-src 'self'"
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff']
      }
    })
  })

  // The UI needs no device permissions at all; refuse every request.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    log.warn('security', `Denied permission request: ${permission}`)
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  // Nothing in this app talks to the network from the renderer.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const url = details.url
    const isLocal =
      url.startsWith('file://') ||
      url.startsWith('devtools://') ||
      url.startsWith(`${ART_SCHEME}://`) ||
      (isDev && devServer && url.startsWith(devServer)) ||
      (isDev && url.startsWith('ws://localhost'))
    if (isLocal) {
      callback({})
      return
    }
    log.warn('security', `Blocked renderer request to ${url}`)
    callback({ cancel: true })
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

function notify(notification: AppNotification): void {
  const window = getMainWindow()
  if (window && !window.isDestroyed()) window.webContents.send('event:notification', notification)

  if (!Notification.isSupported()) return
  try {
    const native = new Notification({ title: notification.title, body: notification.body, silent: false })
    native.on('click', () => navigateTo(notification.route ?? 'home'))
    native.show()
  } catch (error) {
    log.warn('notify', describeError(error))
  }
}

async function main(): Promise<void> {
  log.info('startup', `GameDriver Pro ${app.getVersion()} starting (Electron ${process.versions['electron']})`)

  applySecurityPolicy()
  registerArtProtocol()

  process.env['GDP_APP_VERSION'] = app.getVersion()

  registerIpc(() => getMainWindow())
  createMainWindow()
  createTray()

  // Warm the caches the dashboard needs. Failures here are logged and surfaced
  // in the UI as warnings — they must never stop the app from opening.
  void getHardwareSnapshot(true)
    .then((snapshot) => {
      log.info('startup', `Detected ${snapshot.cpu.name} with ${snapshot.gpus.length} GPU(s)`)
      const problems = snapshot.warnings.length
      if (problems > 0) log.warn('startup', `${problems} detection warning(s)`)

      if (getSettings().notifyDriverProblems) {
        const errored = [
          ...snapshot.audio,
          ...snapshot.bluetooth,
          ...snapshot.usb,
          ...snapshot.controllers,
          ...snapshot.cameras
        ].filter((device) => device.status === 'error')
        if (errored.length > 0) {
          notify({
            id: 'device-problem',
            title: 'Driver problem detected',
            body: `Windows reports a problem with ${errored.length} device(s). Open Drivers for details.`,
            tone: 'warning',
            route: 'drivers'
          })
        }
      }
    })
    .catch((error) => log.error('startup', `Hardware detection failed: ${describeError(error)}`))

  if (getSettings().gameDetection) {
    void getGameLibrary(true).catch((error) => log.warn('startup', `Game detection failed: ${describeError(error)}`))
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })

  app.on('before-quit', () => {
    markQuitting()
    monitor.stop()
    destroyTray()
    store.close()
  })

  app.on('window-all-closed', () => {
    // The tray keeps the app alive on Windows when the user closes the window,
    // unless they turned that off.
    if (!getSettings().minimizeToTray) app.quit()
  })

  refreshTrayMenu()
}

process.on('uncaughtException', (error) => {
  log.error('process', `Uncaught exception: ${describeError(error)}`)
})

process.on('unhandledRejection', (reason) => {
  log.error('process', `Unhandled rejection: ${describeError(reason)}`)
})
