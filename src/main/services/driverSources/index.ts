import { getHardwareSnapshot } from '../hardware'
import { getDriverInventory } from '../drivers'
import { GAMING_CATEGORIES } from '../classify'
import { store } from '../db'
import { log, describeError } from '../logger'
import { catalogSource } from './catalogSource'
import { nvidiaSource } from './nvidiaSource'
import { vendorPageSource } from './vendorPages'
import { windowsUpdateSource } from './windowsUpdate'
import type { DriverSource, SourceContext } from './types'
import type { DriverUpdate, ScanProgress, ScanResult, SourceStatus } from '../../../shared/types'

/**
 * The driver update scanner.
 *
 * Order matters: hardware first, then the installed inventory, then each
 * official source in turn. Every source reports its own state so the UI can say
 * exactly which sources answered and which did not — a source being unreachable
 * is surfaced, never silently treated as "nothing to update".
 */

export const SOURCES: DriverSource[] = [nvidiaSource, windowsUpdateSource, catalogSource, vendorPageSource]

export interface ScanOptions {
  allowVendorLookups: boolean
  allowWindowsUpdate: boolean
  onProgress?: (progress: ScanProgress) => void
}

let lastResult: ScanResult | null = null
let running = false

export function isScanRunning(): boolean {
  return running
}

export function lastScanResult(): ScanResult | null {
  return lastResult
}

export function lastSourceStatuses(): SourceStatus[] {
  return lastResult?.sources ?? []
}

export async function scanForDriverUpdates(options: ScanOptions): Promise<ScanResult> {
  if (running) {
    throw new Error('A driver scan is already running.')
  }
  running = true
  const startedAt = Date.now()
  const errors: string[] = []
  const statuses: SourceStatus[] = []
  const updates: DriverUpdate[] = []

  const enabledSources = SOURCES.filter((source) => {
    // The catalogue is a Microsoft source, so it follows the Windows Update
    // switch rather than the manufacturer-lookup one.
    if (source.id === 'windows-update' || source.id === 'update-catalog') return options.allowWindowsUpdate
    if (source.kind === 'vendor-api') return options.allowVendorLookups
    return true
  })

  const totalSteps = 2 + enabledSources.length
  let step = 0
  const report = (progress: Omit<ScanProgress, 'step' | 'totalSteps'>) => {
    options.onProgress?.({ ...progress, step, totalSteps })
  }

  try {
    step = 1
    report({ phase: 'hardware', label: 'Detecting hardware' })
    const hardware = await getHardwareSnapshot(true)

    step = 2
    report({ phase: 'inventory', label: 'Reading installed drivers' })
    const inventory = await getDriverInventory(true)

    const ctx: SourceContext = {
      hardware,
      drivers: inventory.entries,
      allowNetwork: options.allowVendorLookups || options.allowWindowsUpdate,
      signal: { aborted: false }
    }

    for (const source of enabledSources) {
      step += 1
      report({ phase: 'sources', label: `Checking ${source.label}`, detail: source.label })

      if (!source.applicable(ctx)) {
        statuses.push({
          id: source.id,
          label: source.label,
          state: 'skipped',
          detail: 'Not applicable to this PC, or disabled in Settings.',
          durationMs: 0
        })
        continue
      }

      const sourceStarted = Date.now()
      try {
        const result = await source.check(ctx)
        statuses.push({ ...result.status, durationMs: Date.now() - sourceStarted })
        updates.push(...result.updates)
      } catch (error) {
        const message = describeError(error)
        errors.push(`${source.label}: ${message}`)
        statuses.push({
          id: source.id,
          label: source.label,
          state: 'error',
          detail: message,
          durationMs: Date.now() - sourceStarted
        })
      }
    }

    for (const source of SOURCES) {
      if (enabledSources.includes(source)) continue
      statuses.push({
        id: source.id,
        label: source.label,
        state: 'skipped',
        detail: 'Disabled in Settings › Privacy.',
        durationMs: 0
      })
    }

    step = totalSteps
    report({ phase: 'done', label: 'Scan complete' })

    const result: ScanResult = {
      startedAt,
      finishedAt: Date.now(),
      sources: statuses,
      updates: dedupe(updates),
      scannedCategories: GAMING_CATEGORIES,
      errors
    }
    lastResult = result

    store.addHistory({
      timestamp: Date.now(),
      kind: 'scan',
      device: null,
      category: null,
      fromVersion: null,
      toVersion: null,
      result: 'success',
      source: statuses.map((s) => `${s.id}:${s.state}`).join(', '),
      detail: `${result.updates.length} item(s) reported across ${statuses.length} source(s)`
    })

    log.info(
      'scan',
      `Completed in ${Date.now() - startedAt}ms — ${result.updates.length} item(s), ${errors.length} error(s)`
    )
    return result
  } finally {
    running = false
  }
}

/**
 * Two sources can describe the same device. Prefer the entry that carries a
 * concrete available version, then the one with the stronger classification.
 */
function dedupe(updates: DriverUpdate[]): DriverUpdate[] {
  const weight: Record<DriverUpdate['classification'], number> = {
    critical: 5,
    recommended: 4,
    optional: 3,
    experimental: 2,
    unknown: 1,
    'not-recommended': 0
  }
  const byDevice = new Map<string, DriverUpdate>()
  for (const update of updates) {
    const key = `${update.category}|${update.deviceName.toLowerCase()}`
    const existing = byDevice.get(key)
    if (!existing) {
      byDevice.set(key, update)
      continue
    }
    const existingScore = (existing.availableVersion ? 10 : 0) + weight[existing.classification]
    const candidateScore = (update.availableVersion ? 10 : 0) + weight[update.classification]
    if (candidateScore > existingScore) byDevice.set(key, update)
  }
  return [...byDevice.values()].sort((a, b) => weight[b.classification] - weight[a.classification])
}

export function actionableUpdates(result: ScanResult | null): DriverUpdate[] {
  if (!result) return []
  return result.updates.filter((u) => u.classification === 'critical' || u.classification === 'recommended')
}
