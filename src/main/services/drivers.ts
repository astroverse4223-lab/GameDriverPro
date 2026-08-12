import { queryEmitted } from './powershell'
import { DRIVER_INVENTORY_SCRIPT } from './wmiScripts'
import { categoryFromClass, problemText, statusFromProblem } from './classify'
import { nvidiaVendorVersion } from './nvidia'
import { log, describeError } from './logger'
import type { DriverCategory, DriverEntry, DriverInventory } from '../../shared/types'

/**
 * The installed-driver inventory, read from Win32_PnPSignedDriver and joined
 * with Get-PnpDevice for live device status / problem codes.
 */

interface RawDriverRow {
  deviceId: string | null
  deviceName: string | null
  friendlyName: string | null
  deviceClass: string | null
  manufacturer: string | null
  driverProvider: string | null
  driverVersion: string | null
  driverDate: string | null
  infName: string | null
  isSigned: boolean | null
  hardwareId: string | null
  location: string | null
  status: string | null
  problemCode: number | null
  present: boolean | null
}

interface RawInventory {
  drivers: RawDriverRow[] | RawDriverRow | null
  errors: string[] | null
}

const CACHE_TTL_MS = 120_000
let cached: DriverInventory | null = null
let inFlight: Promise<DriverInventory> | null = null

function arr<T>(value: T[] | T | null | undefined): T[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function splitHardwareIds(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(/\r?\n|;/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function getDriverInventory(force = false): Promise<DriverInventory> {
  if (!force && cached && Date.now() - cached.capturedAt < CACHE_TTL_MS) return cached
  if (inFlight) return inFlight
  inFlight = collect().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function collect(): Promise<DriverInventory> {
  const started = Date.now()
  const warnings: string[] = []

  const raw = await queryEmitted<RawInventory>(DRIVER_INVENTORY_SCRIPT, { timeoutMs: 60_000 }).catch((error) => {
    warnings.push(`Driver inventory query failed: ${describeError(error)}`)
    return null
  })
  warnings.push(...arr(raw?.errors))

  const seen = new Map<string, DriverEntry>()

  for (const row of arr(raw?.drivers)) {
    const name = (row.friendlyName ?? row.deviceName ?? '').trim()
    if (!name) continue
    // Windows lists one row per device instance; several instances routinely
    // share a single driver package (five identical PCIe root ports, for
    // example). This is a driver list, so collapse them to one row per package.
    const key = `${name.toLowerCase()}|${row.driverVersion ?? ''}|${row.infName ?? ''}`
    if (seen.has(key)) continue

    const category = categoryFromClass(row.deviceClass, name)
    const provider = row.driverProvider ?? row.manufacturer
    const isNvidia = /nvidia/i.test(provider ?? '') && category === 'graphics'

    seen.set(key, {
      id: row.deviceId ?? key,
      deviceName: name,
      manufacturer: row.manufacturer && row.manufacturer !== '(Standard system devices)' ? row.manufacturer : null,
      driverProvider: provider,
      driverVersion: row.driverVersion,
      driverDate: row.driverDate,
      infName: row.infName,
      isSigned: row.isSigned,
      category,
      hardwareIds: splitHardwareIds(row.hardwareId),
      deviceId: row.deviceId,
      status: statusFromProblem(row.problemCode, row.status),
      problemCode: row.problemCode && row.problemCode !== 0 ? row.problemCode : null,
      problemText: problemText(row.problemCode),
      displayVersion: isNvidia ? nvidiaVendorVersion(row.driverVersion) : null
    })
  }

  const entries = [...seen.values()].sort((a, b) => a.deviceName.localeCompare(b.deviceName))
  const countsByCategory: Record<string, number> = {}
  for (const entry of entries) {
    countsByCategory[entry.category] = (countsByCategory[entry.category] ?? 0) + 1
  }

  const inventory: DriverInventory = {
    capturedAt: Date.now(),
    entries,
    countsByCategory,
    problemDevices: entries.filter((e) => e.status === 'error').length,
    unsignedDrivers: entries.filter((e) => e.isSigned === false).length,
    warnings
  }

  cached = inventory
  log.info('drivers', `Inventory: ${entries.length} driver packages in ${Date.now() - started}ms`)
  return inventory
}

export function cachedInventory(): DriverInventory | null {
  return cached
}

/** The one driver entry per category that best represents it in summaries. */
export function primaryEntry(inventory: DriverInventory, category: DriverCategory): DriverEntry | null {
  const candidates = inventory.entries.filter((e) => e.category === category)
  if (candidates.length === 0) return null
  // Prefer a real vendor driver over a Microsoft in-box one — that is the entry
  // whose version the user can actually act on.
  const vendor = candidates.find((e) => e.driverProvider !== null && !/^microsoft$/i.test(e.driverProvider))
  return vendor ?? candidates[0] ?? null
}

/**
 * Compare dotted numeric versions. Returns >0 when a is newer, <0 when older,
 * 0 when equal, and null when the two strings are not comparable (different
 * shapes, non-numeric segments) — in which case the app says "unknown" rather
 * than pretending to know which is newer.
 */
export function compareVersions(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const pa = a.trim().split('.')
  const pb = b.trim().split('.')
  if (pa.some((s) => !/^\d+$/.test(s)) || pb.some((s) => !/^\d+$/.test(s))) return null
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const va = Number(pa[i] ?? 0)
    const vb = Number(pb[i] ?? 0)
    if (va !== vb) return va > vb ? 1 : -1
  }
  return 0
}

/**
 * Age of a driver in days, or null when the date is unknown or not credible.
 *
 * Two real-world traps this avoids:
 *  - Windows stamps every in-box driver 21 June 2006 regardless of when it was
 *    actually built, so that date says nothing about the driver's age;
 *  - some firmware reports nonsense dates (a chipset driver on the test machine
 *    claims 1968), which would otherwise be reported as "58 years old".
 * In both cases the honest answer is "unknown", not a number.
 */
const INBOX_PLACEHOLDER_DATE = '2006-06-21'

export function driverAgeDays(driverDate: string | null): number | null {
  if (!driverDate) return null
  const time = Date.parse(driverDate)
  if (Number.isNaN(time)) return null
  const date = new Date(time)
  if (date.getUTCFullYear() < 1995) return null
  if (driverDate.slice(0, 10) === INBOX_PLACEHOLDER_DATE) return null
  const days = Math.floor((Date.now() - time) / 86_400_000)
  return days < 0 ? null : days
}

/** True when this driver is one Windows ships and services itself. */
export function isInboxDriver(entry: Pick<DriverEntry, 'driverProvider' | 'driverDate'>): boolean {
  if (/^microsoft$/i.test(entry.driverProvider ?? '')) return true
  return (entry.driverDate ?? '').slice(0, 10) === INBOX_PLACEHOLDER_DATE
}
