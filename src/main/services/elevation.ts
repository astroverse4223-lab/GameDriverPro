import { spawnSync } from 'node:child_process'
import { log } from './logger'

/**
 * Whether this process holds an elevated (High Mandatory Level) token.
 *
 * Several operations — restore points, driver installation, `pnputil /export-driver`,
 * SMART reliability counters — genuinely require elevation. The app checks up
 * front so it can tell the user *before* they start something that cannot finish,
 * rather than failing halfway through.
 */

let elevated: boolean | null = null

const HIGH_MANDATORY_LEVEL = 'S-1-16-12288'
const SYSTEM_MANDATORY_LEVEL = 'S-1-16-16384'

export function isElevated(): boolean {
  if (elevated !== null) return elevated
  try {
    const result = spawnSync('whoami', ['/groups'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000
    })
    const stdout = result.stdout ?? ''
    elevated = stdout.includes(HIGH_MANDATORY_LEVEL) || stdout.includes(SYSTEM_MANDATORY_LEVEL)
  } catch {
    elevated = false
  }
  log.info('elevation', `Running ${elevated ? 'elevated' : 'unelevated'}`)
  return elevated
}

export const ELEVATION_HINT =
  'Windows requires administrator rights for this. Close GameDriver Pro, right-click it and choose “Run as administrator”, then try again.'

export function requiresElevation(operation: string): { ok: false; message: string } {
  return { ok: false, message: `${operation} needs administrator rights. ${ELEVATION_HINT}` }
}
