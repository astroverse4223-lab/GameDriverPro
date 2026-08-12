import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Shared esbuild options for the two Node-side bundles (main + preload). */
export function nodeBundles(mode) {
  const dev = mode === 'development'
  /** @type {import('esbuild').BuildOptions} */
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    external: ['electron'],
    define: {
      'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production')
    },
    logLevel: 'info',
    absWorkingDir: root
  }

  return [
    { ...common, entryPoints: ['src/main/index.ts'], outdir: 'dist/main' },
    { ...common, entryPoints: ['src/preload/index.ts'], outdir: 'dist/preload' }
  ]
}
