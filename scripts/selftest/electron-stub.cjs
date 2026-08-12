const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const dir = path.join(os.tmpdir(), 'gdp-selftest')
fs.mkdirSync(dir, { recursive: true })

class Noop {}

module.exports = {
  app: {
    getPath: () => dir,
    getVersion: () => '0.1.0-selftest',
    getAppPath: () => process.cwd(),
    setLoginItemSettings() {},
    on() {},
    quit() {},
    whenReady: async () => {},
    requestSingleInstanceLock: () => true,
    setAppUserModelId() {}
  },
  shell: { openExternal: async () => {}, openPath: async () => '' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: Noop,
  ipcMain: { handle() {} },
  Notification: class {
    static isSupported() {
      return false
    }
    on() {}
    show() {}
  },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived() {}, onBeforeRequest() {} },
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {}
    }
  },
  Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
  Tray: Noop,
  nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }), createEmpty: () => ({}) }
}
