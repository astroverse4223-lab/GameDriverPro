import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: r('./src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@renderer': r('./src/renderer')
    }
  },
  server: {
    port: 5273,
    strictPort: true
  },
  build: {
    outDir: r('./dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false
  }
})
