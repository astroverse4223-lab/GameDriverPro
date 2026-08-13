/**
 * Shared data contracts between the main process (privileged, talks to Windows)
 * and the renderer (sandboxed UI).
 *
 * Design rule that runs through this whole file: anything the operating system
 * may refuse to tell us is typed as `| null` and paired with an availability
 * note. The UI is required to render "unavailable" rather than invent a value.
 */

/** Why a piece of data is missing. Never guess — say which of these it was. */
export type Availability = 'ok' | 'unsupported' | 'denied' | 'unavailable' | 'error'

export interface Unavailable {
  availability: Exclude<Availability, 'ok'>
  reason: string
}

// ---------------------------------------------------------------------------
// Hardware
// ---------------------------------------------------------------------------

export interface SystemInfo {
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
  chassis: string | null
  isLaptop: boolean
  isElevated: boolean
}

export interface CpuInfo {
  name: string
  manufacturer: string | null
  physicalCores: number | null
  logicalCores: number | null
  baseClockMhz: number | null
  maxClockMhz: number | null
  socket: string | null
  l2CacheKb: number | null
  l3CacheKb: number | null
  virtualizationEnabled: boolean | null
}

export interface GpuInfo {
  id: string
  name: string
  vendor: GpuVendor
  driverVersion: string | null
  /** Vendor-facing driver version, e.g. NVIDIA 581.42 derived from 32.0.16.1088. */
  displayDriverVersion: string | null
  driverDate: string | null
  driverProvider: string | null
  vramBytes: number | null
  vramSource: 'nvidia-smi' | 'registry' | 'wmi' | null
  videoProcessor: string | null
  currentResolution: string | null
  refreshRateHz: number | null
  status: DeviceStatus
  pnpDeviceId: string | null
  isPrimary: boolean
}

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'microsoft' | 'unknown'

export interface MemoryModule {
  bank: string | null
  slot: string | null
  capacityBytes: number | null
  speedMhz: number | null
  configuredSpeedMhz: number | null
  manufacturer: string | null
  partNumber: string | null
  formFactor: string | null
}

export interface MemoryInfo {
  totalBytes: number
  availableBytes: number
  usedBytes: number
  slotsUsed: number
  slotsTotal: number | null
  modules: MemoryModule[]
}

export interface MotherboardInfo {
  manufacturer: string | null
  product: string | null
  version: string | null
  biosVendor: string | null
  biosVersion: string | null
  biosReleaseDate: string | null
  secureBoot: boolean | null
}

export interface StorageVolume {
  letter: string | null
  label: string | null
  fileSystem: string | null
  totalBytes: number | null
  freeBytes: number | null
}

export interface StorageHealth {
  /** null means: Windows did not expose health for this disk. Do not claim "healthy". */
  status: string | null
  temperatureC: number | null
  powerOnHours: number | null
  wearPercent: number | null
  readErrorsTotal: number | null
  source: 'storage-reliability-counter' | 'msft-physicaldisk' | null
  available: boolean
  note: string
}

export interface StorageDisk {
  id: string
  model: string | null
  friendlyName: string | null
  sizeBytes: number | null
  mediaType: string | null
  busType: string | null
  health: StorageHealth
  volumes: StorageVolume[]
}

export interface NetworkAdapterInfo {
  id: string
  name: string
  description: string | null
  interfaceType: string | null
  status: string | null
  linkSpeedBps: number | null
  ipv4: string | null
  isVirtual: boolean
  driverVersion: string | null
  driverProvider: string | null
}

export interface GenericDevice {
  id: string
  name: string
  manufacturer: string | null
  status: DeviceStatus
  driverVersion: string | null
  driverDate: string | null
  hardwareId: string | null
  problemCode: number | null
}

export interface DisplayInfo {
  id: string
  name: string
  manufacturer: string | null
  resolution: string | null
  refreshRateHz: number | null
  isPrimary: boolean
  diagonalInches: number | null
}

export interface BatteryInfo {
  present: boolean
  chargePercent: number | null
  status: string | null
  designCapacityMwh: number | null
  fullChargeCapacityMwh: number | null
  healthPercent: number | null
}

export type DeviceStatus = 'ok' | 'warning' | 'error' | 'disabled' | 'unknown'

export interface HardwareSnapshot {
  capturedAt: number
  system: SystemInfo
  cpu: CpuInfo
  gpus: GpuInfo[]
  memory: MemoryInfo
  motherboard: MotherboardInfo
  storage: StorageDisk[]
  network: NetworkAdapterInfo[]
  audio: GenericDevice[]
  bluetooth: GenericDevice[]
  usb: GenericDevice[]
  displays: DisplayInfo[]
  controllers: GenericDevice[]
  cameras: GenericDevice[]
  printers: GenericDevice[]
  battery: BatteryInfo
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export type DriverCategory =
  | 'graphics'
  | 'chipset'
  | 'audio'
  | 'network'
  | 'wifi'
  | 'bluetooth'
  | 'storage'
  | 'usb'
  | 'motherboard'
  | 'controller'
  | 'input'
  | 'display'
  | 'camera'
  | 'printer'
  | 'system'
  | 'other'

export interface DriverEntry {
  id: string
  deviceName: string
  manufacturer: string | null
  driverProvider: string | null
  driverVersion: string | null
  driverDate: string | null
  infName: string | null
  isSigned: boolean | null
  category: DriverCategory
  hardwareIds: string[]
  deviceId: string | null
  status: DeviceStatus
  problemCode: number | null
  problemText: string | null
  /** Vendor-facing version where it differs from the Windows version (NVIDIA). */
  displayVersion: string | null
}

export interface DriverInventory {
  capturedAt: number
  entries: DriverEntry[]
  countsByCategory: Record<string, number>
  problemDevices: number
  unsignedDrivers: number
  warnings: string[]
}

/**
 * `not-recommended` is for offers the app actively advises against — chiefly a
 * source offering an older driver than the one installed. It is deliberately
 * distinct from `optional`: "you could take this" and "taking this moves you
 * backwards" must not share a label or a colour.
 */
export type UpdateClassification =
  | 'critical'
  | 'recommended'
  | 'optional'
  | 'experimental'
  | 'unknown'
  | 'not-recommended'
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown'

export interface DriverSourceRef {
  id: string
  label: string
  official: true
  url: string | null
  kind: 'windows-update' | 'vendor-api' | 'vendor-page'
}

/**
 * A vendor package the app can fetch and run itself.
 *
 * Only ever populated from a URL the manufacturer's own API returned, on a host
 * this app recognises as that manufacturer's distribution domain. The signature
 * of the downloaded file is checked against `expectedSigner` before it is
 * allowed to run — so a hijacked URL or a corrupted download cannot execute.
 */
export interface VendorDownload {
  url: string
  /** Publisher name that must appear in the Authenticode signature. */
  expectedSigner: string
  /** Arguments for an unattended install, per the vendor's documented switches. */
  silentArgs: string[]
  /** Adds a clean install (wipes existing profiles/settings first). */
  cleanArgs: string[]
  /** What the installer is, in words, for the confirmation dialog. */
  installerName: string
}

export interface DriverUpdate {
  id: string
  deviceName: string
  category: DriverCategory
  currentVersion: string | null
  availableVersion: string | null
  releaseDate: string | null
  source: DriverSourceRef
  classification: UpdateClassification
  risk: RiskLevel
  /** Human-readable explanation lines. Every recommendation must justify itself. */
  rationale: string[]
  /**
   * 'install'        — installable through the Windows Update Agent.
   * 'vendor-install' — the app can download and run the manufacturer's own installer.
   * 'manual'         — hand off to the manufacturer's official page.
   */
  action: 'install' | 'vendor-install' | 'manual'
  /** Set when action is 'vendor-install'. */
  download: VendorDownload | null
  sizeBytes: number | null
  /** Windows Update identity, when the source is Windows Update. */
  updateIdentity: { updateId: string; revision: number } | null
  verified: boolean
  verificationNote: string
}

export interface SourceStatus {
  id: string
  label: string
  state: 'ok' | 'unavailable' | 'error' | 'skipped'
  detail: string
  durationMs: number
}

export interface ScanResult {
  startedAt: number
  finishedAt: number
  sources: SourceStatus[]
  updates: DriverUpdate[]
  scannedCategories: DriverCategory[]
  errors: string[]
}

export interface ScanProgress {
  phase: 'hardware' | 'inventory' | 'sources' | 'done'
  label: string
  step: number
  totalSteps: number
  detail?: string
}

export interface InstallProgress {
  updateId: string
  stage: 'preparing' | 'restore-point' | 'downloading' | 'verifying' | 'installing' | 'done' | 'failed'
  /** Real percentage, or null when the stage genuinely cannot report one. */
  percent: number | null
  message: string
  /** Bytes transferred so far, when downloading. */
  transferredBytes?: number
  totalBytes?: number
  rebootRequired?: boolean
  error?: string
}

export interface InstallOutcome {
  ok: boolean
  rebootRequired: boolean
  message: string
  resultCode: number | null
}

export interface RestorePointResult {
  ok: boolean
  message: string
  requiresElevation: boolean
  systemProtectionEnabled: boolean | null
}

export interface DriverBackupResult {
  ok: boolean
  destination: string | null
  driverCount: number
  message: string
  requiresElevation: boolean
}

export interface RollbackInfo {
  deviceId: string
  deviceName: string
  currentVersion: string | null
  previousVersion: string | null
  /** Windows only keeps one previous driver; may legitimately be unavailable. */
  rollbackAvailable: boolean
  reason: string
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

export interface GpuSample {
  index: number
  name: string
  usagePercent: number | null
  temperatureC: number | null
  coreClockMhz: number | null
  memoryClockMhz: number | null
  powerWatts: number | null
  powerLimitWatts: number | null
  fanPercent: number | null
  vramUsedBytes: number | null
  vramTotalBytes: number | null
  source: 'nvidia-smi' | 'perf-counters' | 'none'
}

export interface MonitorSample {
  t: number
  cpu: { usagePercent: number | null; temperatureC: number | null; clockMhz: number | null }
  memory: { usedBytes: number; totalBytes: number; usagePercent: number }
  gpus: GpuSample[]
  disk: { readBytesPerSec: number | null; writeBytesPerSec: number | null; activePercent: number | null }
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null }
  app: { cpuPercent: number | null; memoryBytes: number }
}

export interface MonitorCapabilities {
  cpuUsage: boolean
  cpuTemperature: boolean
  gpuTelemetry: boolean
  gpuTelemetrySource: 'nvidia-smi' | 'perf-counters' | 'none'
  diskIo: boolean
  networkIo: boolean
  fps: boolean
  notes: string[]
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

export type GameLauncher = 'steam' | 'epic' | 'gog' | 'ea' | 'ubisoft' | 'battlenet' | 'xbox' | 'other'

export interface GameEntry {
  id: string
  name: string
  launcher: GameLauncher
  installPath: string
  sizeBytes: number | null
  appId: string | null
  lastPlayed: number | null
  executable: string | null
  launchUrl: string | null
  storeUrl: string | null
  heroImageUrl: string | null
}

export interface GameLibrary {
  capturedAt: number
  games: GameEntry[]
  launchers: { launcher: GameLauncher; detected: boolean; path: string | null; note: string }[]
  warnings: string[]
}

export interface GameProfile {
  gameId: string
  name: string
  powerPlan: string | null
  closeApps: string[]
  pauseNotifications: boolean
  startMonitoring: boolean
  notes: string
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Crashes
// ---------------------------------------------------------------------------

export type CrashKind =
  | 'display-driver-timeout'
  | 'bugcheck'
  | 'app-crash'
  | 'driver-error'
  | 'unexpected-shutdown'
  | 'other'

export interface CrashEvent {
  id: string
  timestamp: number
  kind: CrashKind
  providerName: string
  eventId: number
  level: 'critical' | 'error' | 'warning' | 'info'
  message: string
  module: string | null
}

export interface CrashGroup {
  key: string
  title: string
  kind: CrashKind
  count: number
  firstOccurrence: number
  lastOccurrence: number
  /** Deliberately hedged language — these are correlations, not proofs. */
  confidence: 'possible' | 'likely'
  suspected: string | null
  recommendation: string
  evidence: string[]
}

export interface MemoryDumpInfo {
  path: string
  sizeBytes: number
  modifiedAt: number
  kind: 'minidump' | 'kernel'
  /** We never fabricate a stop code — parsed straight out of the dump header. */
  bugcheckCode: string | null
  bugcheckName: string | null
  parseNote: string
}

export interface CrashAnalysis {
  capturedAt: number
  windowDays: number
  available: boolean
  events: CrashEvent[]
  groups: CrashGroup[]
  dumps: MemoryDumpInfo[]
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Health / scan
// ---------------------------------------------------------------------------

export type CheckState = 'pass' | 'warn' | 'fail' | 'unknown'

export interface HealthCheck {
  id: string
  label: string
  state: CheckState
  /** Problem → why it matters → evidence → action → risk. Required by the spec. */
  problem: string
  why: string
  evidence: string[]
  action: string
  risk: RiskLevel
  route: AppRoute | null
}

export interface HealthReport {
  generatedAt: number
  score: number
  /** Checks that could not be evaluated do not silently count as passes. */
  evaluatedChecks: number
  checks: HealthCheck[]
  summary: string
}

// ---------------------------------------------------------------------------
// Optimization / boost
// ---------------------------------------------------------------------------

export interface BoostAction {
  id: string
  label: string
  detail: string
  /** Everything is opt-in and reversible; nothing is applied without a tick. */
  enabled: boolean
  reversible: boolean
  requiresElevation: boolean
  available: boolean
  unavailableReason: string | null
}

export interface BoostPlan {
  actions: BoostAction[]
  closableProcesses: ProcessInfo[]
  powerPlans: PowerPlan[]
  activePowerPlan: string | null
}

export interface BoostResult {
  applied: { id: string; ok: boolean; message: string }[]
  revertToken: string | null
}

export interface PowerPlan {
  guid: string
  name: string
  active: boolean
}

export interface ProcessInfo {
  pid: number
  name: string
  description: string | null
  memoryBytes: number
  cpuPercent: number | null
  category: 'browser' | 'launcher' | 'updater' | 'overlay' | 'recording' | 'communication' | 'system' | 'other'
  /** Windows-critical processes are never offered for termination. */
  protected: boolean
  windowTitle: string | null
}

export interface StartupItem {
  name: string
  command: string | null
  location: string
  enabled: boolean
  impact: 'high' | 'medium' | 'low' | 'unknown'
  publisher: string | null
  protected: boolean
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export interface NetworkTestResult {
  target: string
  pingMs: number | null
  jitterMs: number | null
  packetLossPercent: number | null
  samples: number[]
  dnsMs: number | null
  rating: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown'
  note: string
}

// ---------------------------------------------------------------------------
// History / settings / diagnostics
// ---------------------------------------------------------------------------

export type HistoryKind =
  | 'driver-install'
  | 'driver-rollback'
  | 'restore-point'
  | 'driver-backup'
  | 'scan'
  | 'boost'

export interface HistoryRecord {
  id: number
  timestamp: number
  kind: HistoryKind
  device: string | null
  category: string | null
  fromVersion: string | null
  toVersion: string | null
  result: 'success' | 'failed' | 'cancelled' | 'pending'
  source: string | null
  detail: string | null
}

export interface AppSettings {
  launchOnStartup: boolean
  minimizeToTray: boolean
  monitorIntervalMs: number
  allowVendorLookups: boolean
  allowWindowsUpdateScan: boolean
  notifyDriverUpdates: boolean
  notifyDriverProblems: boolean
  gameDetection: boolean
  developerMode: boolean
  theme: 'nebula' | 'ember' | 'toxic'
}

export interface Diagnostics {
  versions: {
    app: string
    electron: string
    chrome: string
    node: string
    v8: string
    os: string
  }
  database: { engine: string; path: string; ok: boolean; records: number }
  ipc: { channels: number; callsHandled: number; errors: number }
  sources: SourceStatus[]
  capabilities: MonitorCapabilities
  hardwareApis: { name: string; ok: boolean; detail: string }[]
  memoryBytes: number
  uptimeSeconds: number
  logTail: string[]
}

export type AppRoute =
  | 'home'
  | 'mypc'
  | 'drivers'
  | 'games'
  | 'boost'
  | 'performance'
  | 'crashes'
  | 'network'
  | 'history'
  | 'settings'
  | 'developer'

export interface AppNotification {
  id: string
  title: string
  body: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  route: AppRoute | null
}
