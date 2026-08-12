import { build } from 'esbuild'
import { build as viteBuild } from 'vite'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { nodeBundles } from './esbuild.config.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true })

for (const options of nodeBundles('production')) {
  await build(options)
}

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..." which
// then gets resolved relative to the drive root.
await viteBuild({ configFile: fileURLToPath(new URL('../vite.config.mts', import.meta.url)) })

console.log('\n  GameDriver Pro build complete →', root + 'dist')
