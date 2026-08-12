import type {
  AppSettings,
  BoostPlan,
  BoostResult,
  CrashAnalysis,
  Diagnostics,
  DriverBackupResult,
  DriverInventory,
  DriverUpdate,
  GameLibrary,
  GameProfile,
  HardwareSnapshot,
  HealthReport,
  HistoryRecord,
  InstallOutcome,
  InstallProgress,
  MonitorCapabilities,
  MonitorSample,
  NetworkTestResult,
  PowerPlan,
  ProcessInfo,
  RestorePointResult,
  RollbackInfo,
  ScanProgress,
  ScanResult,
  StartupItem,
  AppNotification
} from './types'

/**
 * Every privileged operation crosses this boundary. Channels are an explicit
 * allow-list: the preload bridge only forwards names present here, and the main
 * process refuses anything it has not registered a validated handler for.
 */
export const INVOKE_CHANNELS = [
  'hardware:get',
  'hardware:refresh',
  'drivers:inventory',
  'drivers:scan',
  'drivers:rollbackInfo',
  'drivers:openRollbackUi',
  'drivers:install',
  'drivers:backup',
  'drivers:pickBackupFolder',
  'system:createRestorePoint',
  'system:restorePointStatus',
  'health:report',
  'monitor:start',
  'monitor:stop',
  'monitor:capabilities',
  'games:list',
  'games:launch',
  'games:openFolder',
  'games:profileGet',
  'games:profileSave',
  'crashes:analyze',
  'boost:plan',
  'boost:apply',
  'boost:revert',
  'processes:list',
  'startup:list',
  'startup:setEnabled',
  'network:test',
  'power:plans',
  'power:setPlan',
  'history:list',
  'history:clear',
  'settings:get',
  'settings:set',
  'diagnostics:get',
  'app:openExternal',
  'app:openPath',
  'app:windowControl',
  'app:relaunch'
] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

/** Main → renderer pushes. */
export const EVENT_CHANNELS = [
  'event:scanProgress',
  'event:installProgress',
  'event:monitorSample',
  'event:notification',
  'event:navigate'
] as const

export type EventChannel = (typeof EVENT_CHANNELS)[number]

export interface InstallRequest {
  updateId: string
  createRestorePoint: boolean
  /** The renderer must echo back what the user was shown and agreed to. */
  confirmedDeviceName: string
  confirmedFromVersion: string | null
  confirmedToVersion: string | null
}

export interface StartupToggleRequest {
  name: string
  location: string
  enabled: boolean
}

export interface BoostApplyRequest {
  actionIds: string[]
  closePids: number[]
  powerPlanGuid: string | null
}

export interface WindowControlRequest {
  action: 'minimize' | 'maximize' | 'close'
}

/** The exact surface exposed on `window.gdp` in the renderer. */
export interface GdpApi {
  hardware: {
    get(): Promise<HardwareSnapshot>
    refresh(): Promise<HardwareSnapshot>
  }
  drivers: {
    inventory(refresh?: boolean): Promise<DriverInventory>
    scan(): Promise<ScanResult>
    rollbackInfo(deviceId: string): Promise<RollbackInfo>
    openRollbackUi(deviceId: string): Promise<{ ok: boolean; message: string }>
    install(req: InstallRequest): Promise<InstallOutcome>
    backup(destination: string | null): Promise<DriverBackupResult>
    pickBackupFolder(): Promise<string | null>
  }
  system: {
    createRestorePoint(description: string): Promise<RestorePointResult>
    restorePointStatus(): Promise<{ enabled: boolean | null; note: string }>
  }
  health: {
    report(): Promise<HealthReport>
  }
  monitor: {
    start(): Promise<MonitorCapabilities>
    stop(): Promise<void>
    capabilities(): Promise<MonitorCapabilities>
  }
  games: {
    list(refresh?: boolean): Promise<GameLibrary>
    launch(gameId: string): Promise<{ ok: boolean; message: string }>
    openFolder(gameId: string): Promise<{ ok: boolean; message: string }>
    profileGet(gameId: string): Promise<GameProfile | null>
    profileSave(profile: GameProfile): Promise<void>
  }
  crashes: {
    analyze(windowDays: number): Promise<CrashAnalysis>
  }
  boost: {
    plan(): Promise<BoostPlan>
    apply(req: BoostApplyRequest): Promise<BoostResult>
    revert(token: string): Promise<{ ok: boolean; message: string }>
  }
  processes: {
    list(): Promise<ProcessInfo[]>
  }
  startup: {
    list(): Promise<StartupItem[]>
    setEnabled(req: StartupToggleRequest): Promise<{ ok: boolean; message: string }>
  }
  network: {
    test(): Promise<NetworkTestResult>
  }
  power: {
    plans(): Promise<PowerPlan[]>
    setPlan(guid: string): Promise<{ ok: boolean; message: string }>
  }
  history: {
    list(limit?: number): Promise<HistoryRecord[]>
    clear(): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  diagnostics: {
    get(): Promise<Diagnostics>
  }
  app: {
    openExternal(url: string): Promise<{ ok: boolean; message: string }>
    openPath(path: string): Promise<{ ok: boolean; message: string }>
    windowControl(req: WindowControlRequest): Promise<void>
    relaunch(): Promise<void>
  }
  on: {
    scanProgress(cb: (p: ScanProgress) => void): () => void
    installProgress(cb: (p: InstallProgress) => void): () => void
    monitorSample(cb: (s: MonitorSample) => void): () => void
    notification(cb: (n: AppNotification) => void): () => void
    navigate(cb: (route: string) => void): () => void
  }
  meta: {
    platform: string
    isWindows: boolean
    appVersion: string
  }
}
