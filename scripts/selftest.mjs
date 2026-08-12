import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Bundles the self-test entry with `electron` aliased to a stub, then runs it in
 * plain Node. This exercises the real service layer against the real machine
 * without needing the Electron runtime or the UI.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const out = fileURLToPath(new URL('../dist/selftest.cjs', import.meta.url))
const stub = fileURLToPath(new URL('./selftest/electron-stub.cjs', import.meta.url))

await build({
  absWorkingDir: root,
  entryPoints: ['scripts/selftest/entry.ts'],
  outfile: out,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: 'inline',
  alias: { electron: stub },
  logLevel: 'warning'
})

const child = spawn(process.execPath, [out], {
  stdio: 'inherit',
  // Electron sets this in some shells; it must not leak into the child.
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_ENV: 'development' }
})
child.on('exit', (code) => process.exit(code ?? 1))
