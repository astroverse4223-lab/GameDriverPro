import { totalmem, freemem } from 'node:os'
import { queryEmitted } from './powershell'
import { CORE_HARDWARE_SCRIPT, NETWORK_SCRIPT, STORAGE_SCRIPT } from './wmiScripts'
import { readNvidiaGpus, nvidiaVendorVersion } from './nvidia'
import { getDriverInventory } from './drivers'
import { categoryFromClass, gpuVendorOf, problemText, statusFromProblem } from './classify'
import { log, describeError } from './logger'
import { isElevated } from './elevation'
import type {
  BatteryInfo,
  DisplayInfo,
  GenericDevice,
  GpuInfo,
  GpuVendor,
  HardwareSnapshot,
  MemoryInfo,
  NetworkAdapterInfo,
  StorageDisk,
  DriverEntry
} from '../../shared/types'

/** Chassis types that indicate a portable machine (SMBIOS 3.3.4.1). */
const PORTABLE_CHASSIS = new Set([8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32])

const CACHE_TTL_MS = 60_000
let cached: HardwareSnapshot | null = null
let inFlight: Promise<HardwareSnapshot> | null = null

// --- raw PowerShell shapes --------------------------------------------------

interface RawCore {
  system: {
    hostname: string
    osCaption: string
    osVersion: string
    osBuild: string
    osArchitecture: string
    installDate: string | null
    lastBootTime: string | null
    uptimeSeconds: number | null
    manufacturer: string | null
    model: string | null
    chassisTypes: number[] | number | null
    totalMemory: number | null
    freeMemoryKb: number | null
  } | null
  cpu: {
    name: string
    manufacturer: string | null
    physicalCores: number | null
    logicalCores: number | null
    baseClockMhz: number | null
    maxClockMhz: number | null
    socket: string | null
    l2CacheKb: number | null
    l3CacheKb: number | null
    virtualization: boolean | null
  } | null
  gpus: RawGpu[] | RawGpu | null
  memory: { modules: RawModule[] | RawModule | null; slotsTotal: number | null } | null
  motherboard: {
    manufacturer: string | null
    product: string | null
    version: string | null
    biosVendor: string | null
    biosVersion: string | null
    biosReleaseDate: string | null
    secureBoot: boolean | null
  } | null
  displays: RawDisplay[] | RawDisplay | null
  battery: {
    present: boolean
    chargePercent?: number | null
    statusCode?: number | null
    designCapacity?: number | null
    fullCapacity?: number | null
  } | null
  errors: string[] | null
}

interface RawGpu {
  name: string
  driverVersion: string | null
  driverDate: string | null
  driverProvider: string | null
  vramBytes: number | null
  vramFromRegistry: boolean
  videoProcessor: string | null
  currentResolution: string | null
  refreshRateHz: number | null
  statusCode: number | null
  pnpDeviceId: string | null
}

interface RawModule {
  bank: string | null
  slot: string | null
  capacityBytes: number | null
  speedMhz: number | null
  configuredSpeedMhz: number | null
  manufacturer: string | null
  partNumber: string | null
  formFactor: number | null
  memoryType: number | null
}

interface RawDisplay {
  instance: string
  name: string | null
  manufacturer: string | null
  productCode: string | null
  diagonalInches: number | null
  active: boolean | null
}

interface RawStorage {
  storage: RawDisk[] | RawDisk | null
  errors: string[] | null
}

interface RawDisk {
  deviceId: string
  model: string | null
  friendlyName: string | null
  sizeBytes: number | null
  mediaType: string | null
  busType: string | null
  healthStatus: string | null
  operational: string | null
  temperatureC: number | null
  powerOnHours: number | null
  wearPercent: number | null
  readErrors: number | null
  reliability: boolean
  volumes: RawVolume[] | RawVolume | null
}

interface RawVolume {
  letter: string | null
  label: string | null
  fileSystem: string | null
  totalBytes: number | null
  freeBytes: number | null
}

interface RawNetwork {
  network: RawAdapter[] | RawAdapter | null
  errors: string[] | null
}

interface RawAdapter {
  id: string
  name: string
  description: string | null
  interfaceType: string | null
  physicalMedia: string | null
  status: string | null
  linkSpeedBps: number | null
  ipv4: string | null
  isVirtual: boolean
  driverVersion: string | null
  driverProvider: string | null
}

/** PowerShell's ConvertTo-Json unwraps single-element arrays — put them back. */
function arr<T>(value: T[] | T | null | undefined): T[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

const FORM_FACTORS: Record<number, string> = {
  0: 'Unknown',
  8: 'DIMM',
  12: 'SODIMM',
  13: 'SRIMM',
  9: 'DIMM'
}

const MEMORY_TYPES: Record<number, string> = {
  20: 'DDR',
  21: 'DDR2',
  24: 'DDR3',
  26: 'DDR4',
  34: 'DDR5',
  35: 'DDR5'
}

export function memoryLabel(module: RawModule): string | null {
  const type = module.memoryType === null ? null : MEMORY_TYPES[module.memoryType]
  const form = module.formFactor === null ? null : FORM_FACTORS[module.formFactor]
  return [type, form].filter(Boolean).join(' ') || null
}

// --- builders ---------------------------------------------------------------

/**
 * Order adapters so the gaming GPU comes first.
 *
 * Windows enumerates video controllers in bus order, which on a machine with
 * integrated graphics puts the iGPU ahead of the discrete card. Every summary in
 * the UI reads gpus[0], and telemetry from nvidia-smi describes the discrete
 * card — so leaving WMI's order would pair the iGPU's name with the discrete
 * card's readings.
 */
const VENDOR_RANK: Record<GpuVendor, number> = {
  nvidia: 0,
  amd: 1,
  intel: 2,
  unknown: 3,
  microsoft: 4
}

async function buildGpus(raw: RawGpu[]): Promise<GpuInfo[]> {
  const nvidia = await readNvidiaGpus()

  const built = raw.map((gpu, index) => {
    const vendor = gpuVendorOf(gpu.name, gpu.driverProvider)
    const match = nvidia.find((n) => n.name.trim().toLowerCase() === gpu.name.trim().toLowerCase())

    let vram = gpu.vramBytes
    let vramSource: GpuInfo['vramSource'] = gpu.vramBytes === null ? null : gpu.vramFromRegistry ? 'registry' : 'wmi'
    if (match?.vramTotalBytes) {
      vram = match.vramTotalBytes
      vramSource = 'nvidia-smi'
    }

    // Prefer the vendor's own reported version; fall back to the documented
    // Windows→NVIDIA mapping; otherwise leave it null rather than guessing.
    const displayVersion =
      vendor === 'nvidia' ? (match?.driverVersion ?? nvidiaVendorVersion(gpu.driverVersion)) : null

    return {
      id: gpu.pnpDeviceId ?? `gpu-${index}`,
      name: gpu.name,
      vendor,
      driverVersion: gpu.driverVersion,
      displayDriverVersion: displayVersion,
      driverDate: gpu.driverDate,
      driverProvider: gpu.driverProvider,
      vramBytes: vram,
      vramSource,
      videoProcessor: gpu.videoProcessor,
      currentResolution: gpu.currentResolution,
      refreshRateHz: gpu.refreshRateHz,
      status: statusFromProblem(gpu.statusCode, null),
      pnpDeviceId: gpu.pnpDeviceId,
      isPrimary: gpu.currentResolution !== null
    }
  })

  return built.sort((a, b) => VENDOR_RANK[a.vendor] - VENDOR_RANK[b.vendor])
}

function buildMemory(raw: RawCore['memory'], totalFromCs: number | null): MemoryInfo {
  const modules = arr(raw?.modules).map((m) => ({
    bank: m.bank,
    slot: m.slot,
    capacityBytes: m.capacityBytes,
    speedMhz: m.configuredSpeedMhz ?? m.speedMhz,
    configuredSpeedMhz: m.configuredSpeedMhz,
    manufacturer: m.manufacturer,
    partNumber: m.partNumber,
    formFactor: memoryLabel(m)
  }))

  const total = totalFromCs ?? totalmem()
  const available = freemem()
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: Math.max(0, total - available),
    slotsUsed: modules.length,
    slotsTotal: raw?.slotsTotal ?? null,
    modules
  }
}

function buildStorage(raw: RawDisk[]): StorageDisk[] {
  return raw.map((disk) => ({
    id: disk.deviceId,
    model: disk.model,
    friendlyName: disk.friendlyName,
    sizeBytes: disk.sizeBytes,
    mediaType: disk.mediaType === 'Unspecified' ? null : disk.mediaType,
    busType: disk.busType,
    health: {
      status: disk.healthStatus ?? null,
      temperatureC: disk.temperatureC,
      powerOnHours: disk.powerOnHours,
      wearPercent: disk.wearPercent,
      readErrorsTotal: disk.readErrors,
      source: disk.reliability ? 'storage-reliability-counter' : disk.healthStatus ? 'msft-physicaldisk' : null,
      available: disk.reliability,
      note: disk.reliability
        ? 'Values read from the drive’s own reliability counters.'
        : 'This drive did not return SMART/reliability counters. Windows still reports an overall health state, but temperature, wear and power-on hours are unavailable — often because the request needs administrator rights or the enclosure does not pass SMART through.'
    },
    volumes: arr(disk.volumes).map((v) => ({
      letter: v.letter,
      label: v.label && v.label.length > 0 ? v.label : null,
      fileSystem: v.fileSystem,
      totalBytes: v.totalBytes,
      freeBytes: v.freeBytes
    }))
  }))
}

function buildNetwork(raw: RawAdapter[]): NetworkAdapterInfo[] {
  return raw.map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    description: adapter.description,
    interfaceType: adapter.physicalMedia && adapter.physicalMedia !== 'Unspecified' ? adapter.physicalMedia : adapter.interfaceType,
    status: adapter.status,
    linkSpeedBps: adapter.linkSpeedBps && adapter.linkSpeedBps > 0 ? adapter.linkSpeedBps : null,
    ipv4: adapter.ipv4,
    isVirtual: adapter.isVirtual,
    driverVersion: adapter.driverVersion,
    driverProvider: adapter.driverProvider
  }))
}

function buildDisplays(raw: RawDisplay[], gpus: GpuInfo[]): DisplayInfo[] {
  const primary = gpus.find((g) => g.currentResolution !== null)
  return raw.map((display, index) => ({
    id: display.instance,
    name: display.name && display.name.length > 0 ? display.name : (display.manufacturer ?? 'Display'),
    manufacturer: display.manufacturer,
    // Windows exposes the active mode per adapter, not per monitor, so only the
    // first display can be attributed a resolution with confidence.
    resolution: index === 0 ? (primary?.currentResolution ?? null) : null,
    refreshRateHz: index === 0 ? (primary?.refreshRateHz ?? null) : null,
    isPrimary: index === 0,
    diagonalInches: display.diagonalInches
  }))
}

function buildBattery(raw: RawCore['battery']): BatteryInfo {
  if (!raw?.present) {
    return {
      present: false,
      chargePercent: null,
      status: null,
      designCapacityMwh: null,
      fullChargeCapacityMwh: null,
      healthPercent: null
    }
  }
  const design = raw.designCapacity ?? null
  const full = raw.fullCapacity ?? null
  const statusMap: Record<number, string> = {
    1: 'Discharging',
    2: 'On AC power',
    3: 'Fully charged',
    4: 'Low',
    5: 'Critical',
    6: 'Charging',
    7: 'Charging (high)',
    8: 'Charging (low)',
    9: 'Charging (critical)',
    10: 'Undefined',
    11: 'Partially charged'
  }
  return {
    present: true,
    chargePercent: raw.chargePercent ?? null,
    status: raw.statusCode ? (statusMap[raw.statusCode] ?? null) : null,
    designCapacityMwh: design,
    fullChargeCapacityMwh: full,
    healthPercent: design && full && design > 0 ? Math.round((full / design) * 100) : null
  }
}

function devicesFromDrivers(entries: DriverEntry[], categories: string[]): GenericDevice[] {
  return entries
    .filter((entry) => categories.includes(entry.category))
    .map((entry) => ({
      id: entry.id,
      name: entry.deviceName,
      manufacturer: entry.manufacturer ?? entry.driverProvider,
      status: entry.status,
      driverVersion: entry.driverVersion,
      driverDate: entry.driverDate,
      hardwareId: entry.hardwareIds[0] ?? null,
      problemCode: entry.problemCode
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// --- public API -------------------------------------------------------------

export async function getHardwareSnapshot(force = false): Promise<HardwareSnapshot> {
  if (!force && cached && Date.now() - cached.capturedAt < CACHE_TTL_MS) return cached
  if (inFlight) return inFlight

  inFlight = collect(force).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function collect(force: boolean): Promise<HardwareSnapshot> {
  const started = Date.now()
  const warnings: string[] = []

  // Three independent PowerShell sessions in parallel: the storage and network
  // modules each pay ~2s of module autoload, so serialising them would triple
  // the time the boot screen has to cover.
  const [core, storage, network, inventory] = await Promise.all([
    queryEmitted<RawCore>(CORE_HARDWARE_SCRIPT, { timeoutMs: 40_000 }).catch((error) => {
      warnings.push(`Core hardware query failed: ${describeError(error)}`)
      return null
    }),
    queryEmitted<RawStorage>(STORAGE_SCRIPT, { timeoutMs: 40_000 }).catch((error) => {
      warnings.push(`Storage query failed: ${describeError(error)}`)
      return null
    }),
    queryEmitted<RawNetwork>(NETWORK_SCRIPT, { timeoutMs: 40_000 }).catch((error) => {
      warnings.push(`Network query failed: ${describeError(error)}`)
      return null
    }),
    getDriverInventory(force).catch((error) => {
      warnings.push(`Driver inventory failed: ${describeError(error)}`)
      return null
    })
  ])

  for (const err of [...arr(core?.errors), ...arr(storage?.errors), ...arr(network?.errors)]) {
    warnings.push(err)
  }

  const gpus = await buildGpus(arr(core?.gpus))
  const entries = inventory?.entries ?? []

  const snapshot: HardwareSnapshot = {
    capturedAt: Date.now(),
    system: {
      hostname: core?.system?.hostname ?? 'Unknown PC',
      osCaption: core?.system?.osCaption ?? 'Windows',
      osVersion: core?.system?.osVersion ?? '',
      osBuild: core?.system?.osBuild ?? '',
      osArchitecture: core?.system?.osArchitecture ?? '',
      installDate: core?.system?.installDate ?? null,
      lastBootTime: core?.system?.lastBootTime ?? null,
      uptimeSeconds: core?.system?.uptimeSeconds ?? null,
      manufacturer: core?.system?.manufacturer ?? null,
      model: core?.system?.model ?? null,
      chassis: null,
      isLaptop: arr(core?.system?.chassisTypes).some((t) => PORTABLE_CHASSIS.has(Number(t))),
      isElevated: isElevated()
    },
    cpu: {
      name: core?.cpu?.name?.trim() ?? 'Unknown processor',
      manufacturer: core?.cpu?.manufacturer ?? null,
      physicalCores: core?.cpu?.physicalCores ?? null,
      logicalCores: core?.cpu?.logicalCores ?? null,
      baseClockMhz: core?.cpu?.baseClockMhz ?? null,
      maxClockMhz: core?.cpu?.maxClockMhz ?? null,
      socket: core?.cpu?.socket ?? null,
      l2CacheKb: core?.cpu?.l2CacheKb ?? null,
      l3CacheKb: core?.cpu?.l3CacheKb ?? null,
      virtualizationEnabled: core?.cpu?.virtualization ?? null
    },
    gpus,
    memory: buildMemory(core?.memory ?? null, core?.system?.totalMemory ?? null),
    motherboard: {
      manufacturer: core?.motherboard?.manufacturer ?? null,
      product: core?.motherboard?.product ?? null,
      version: core?.motherboard?.version ?? null,
      biosVendor: core?.motherboard?.biosVendor ?? null,
      biosVersion: core?.motherboard?.biosVersion ?? null,
      biosReleaseDate: core?.motherboard?.biosReleaseDate ?? null,
      secureBoot: core?.motherboard?.secureBoot ?? null
    },
    storage: buildStorage(arr(storage?.storage)),
    network: buildNetwork(arr(network?.network)),
    audio: devicesFromDrivers(entries, ['audio']),
    bluetooth: devicesFromDrivers(entries, ['bluetooth']),
    usb: devicesFromDrivers(entries, ['usb']),
    displays: buildDisplays(arr(core?.displays), gpus),
    controllers: devicesFromDrivers(entries, ['controller']),
    cameras: devicesFromDrivers(entries, ['camera']),
    printers: devicesFromDrivers(entries, ['printer']),
    battery: buildBattery(core?.battery ?? null),
    warnings
  }

  // Chassis label is derived from the numeric SMBIOS type list.
  snapshot.system.chassis = snapshot.system.isLaptop ? 'Portable' : 'Desktop'

  cached = snapshot
  log.info('hardware', `Snapshot captured in ${Date.now() - started}ms (${warnings.length} warnings)`)
  return snapshot
}

export function cachedHardware(): HardwareSnapshot | null {
  return cached
}

/** Re-export so callers do not need to know which module classifies devices. */
export { categoryFromClass, problemText }
