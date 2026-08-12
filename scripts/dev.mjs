import { context } from 'esbuild'
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { nodeBundles } from './esbuild.config.mjs'

const DEV_URL = 'http://localhost:5273'

const server = await createServer({
  configFile: fileURLToPath(new URL('../vite.config.mts', import.meta.url))
})
await server.listen()
server.printUrls()

/** @type {import('node:child_process').ChildProcess | null} */
let electron = null
let restarting = false

function launchElectron() {
  if (electron) {
    restarting = true
    electron.kill()
    electron = null
  }
  electron = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development', GDP_DEV_SERVER_URL: DEV_URL }
  })
  electron.on('exit', () => {
    if (restarting) {
      restarting = false
      return
    }
    server.close().finally(() => process.exit(0))
  })
}

const rebuildPlugin = {
  name: 'gdp-relaunch',
  setup(b) {
    let first = true
    b.onEnd((result) => {
      if (result.errors.length > 0) return
      if (first) {
        first = false
        return
      }
      console.log('[gdp] main/preload rebuilt — restarting Electron')
      launchElectron()
    })
  }
}

const contexts = []
for (const options of nodeBundles('development')) {
  const ctx = await context({ ...options, plugins: [rebuildPlugin] })
  await ctx.rebuild()
  await ctx.watch()
  contexts.push(ctx)
}

launchElectron()

process.on('SIGINT', async () => {
  for (const ctx of contexts) await ctx.dispose()
  await server.close()
  process.exit(0)
})
