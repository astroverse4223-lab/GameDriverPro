import { runExe } from './powershell'
import { log, describeError } from './logger'

/**
 * nvidia-smi wrapper. It ships with the NVIDIA display driver, so its presence
 * is itself the signal for whether GPU telemetry is available at all — we never
 * synthesise numbers for a GPU that cannot report them.
 */

export interface NvidiaGpuReading {
  index: number
  name: string
  driverVersion: string
  vramTotalBytes: number | null
  vramUsedBytes: number | null
  utilizationPercent: number | null
  temperatureC: number | null
  coreClockMhz: number | null
  memoryClockMhz: number | null
  powerWatts: number | null
  powerLimitWatts: number | null
  fanPercent: number | null
}

export const NVIDIA_QUERY_FIELDS = [
  'index',
  'name',
  'driver_version',
  'memory.total',
  'memory.used',
  'utilization.gpu',
  'temperature.gpu',
  'clocks.current.graphics',
  'clocks.current.memory',
  'power.draw',
  'enforced.power.limit',
  'fan.speed'
] as const

let availability: boolean | null = null

function num(raw: string | undefined): number | null {
  if (!raw) return null
  const text = raw.trim()
  // nvidia-smi prints [N/A] / [Not Supported] for fields a card does not expose.
  if (!text || text.startsWith('[')) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

export function parseNvidiaCsvLine(line: string): NvidiaGpuReading | null {
  const parts = line.split(',').map((p) => p.trim())
  if (parts.length < NVIDIA_QUERY_FIELDS.length) return null
  const index = num(parts[0])
  const name = parts[1] ?? ''
  const driverVersion = parts[2] ?? ''
  if (index === null || !name) return null
  const totalMib = num(parts[3])
  const usedMib = num(parts[4])
  return {
    index,
    name,
    driverVersion,
    vramTotalBytes: totalMib === null ? null : Math.round(totalMib * 1024 * 1024),
    vramUsedBytes: usedMib === null ? null : Math.round(usedMib * 1024 * 1024),
    utilizationPercent: num(parts[5]),
    temperatureC: num(parts[6]),
    coreClockMhz: num(parts[7]),
    memoryClockMhz: num(parts[8]),
    powerWatts: num(parts[9]),
    powerLimitWatts: num(parts[10]),
    fanPercent: num(parts[11])
  }
}

export async function readNvidiaGpus(): Promise<NvidiaGpuReading[]> {
  try {
    const stdout = await runExe(
      'nvidia-smi',
      [`--query-gpu=${NVIDIA_QUERY_FIELDS.join(',')}`, '--format=csv,noheader,nounits'],
      8000
    )
    availability = true
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseNvidiaCsvLine)
      .filter((r): r is NvidiaGpuReading => r !== null)
  } catch (error) {
    if (availability !== false) log.info('nvidia', `nvidia-smi unavailable: ${describeError(error)}`)
    availability = false
    return []
  }
}

export async function nvidiaSmiAvailable(): Promise<boolean> {
  if (availability !== null) return availability
  const readings = await readNvidiaGpus()
  return readings.length > 0
}

/**
 * Windows reports NVIDIA drivers as e.g. 32.0.16.1088 while NVIDIA, GeForce
 * Experience and every release note call the same driver 610.88. The mapping is
 * the last five digits of the two trailing version components.
 * Verified against nvidia-smi on real hardware; returns null rather than a guess
 * when the shape does not match.
 */
export function nvidiaVendorVersion(windowsVersion: string | null): string | null {
  if (!windowsVersion) return null
  const parts = windowsVersion.split('.')
  if (parts.length < 4) return null
  const digits = `${parts[2] ?? ''}${parts[3] ?? ''}`.replace(/\D/g, '')
  if (digits.length < 5) return null
  const last5 = digits.slice(-5)
  return `${last5.slice(0, 3)}.${last5.slice(3)}`
}
