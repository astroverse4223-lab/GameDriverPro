import type { GdpApi } from '../../shared/ipc'

declare global {
  interface Window {
    gdp: GdpApi
  }
}

/**
 * The single accessor for the preload bridge. Everything privileged the UI does
 * goes through here, so there is exactly one place to look for "what can this
 * screen actually touch?".
 */
export const api: GdpApi = window.gdp

export const isWindows = Boolean(window.gdp?.meta?.isWindows)

/** Turn a rejected IPC call into a message worth showing a person. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Electron prefixes IPC rejections with the handler location; strip it.
    return error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
  }
  if (typeof error === 'string') return error
  return 'Something went wrong.'
}
