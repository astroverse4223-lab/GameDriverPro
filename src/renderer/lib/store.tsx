import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, errorMessage } from './api'
import type {
  AppRoute,
  AppSettings,
  DriverInventory,
  HardwareSnapshot,
  HealthReport,
  MonitorCapabilities,
  MonitorSample,
  ScanProgress,
  ScanResult
} from '../../shared/types'

/**
 * Application state shared across screens.
 *
 * Held in one provider rather than refetched per page so that the dashboard,
 * driver manager and health score always agree with each other — and so a
 * 10-second hardware sweep runs once, not once per navigation.
 */

export interface Toast {
  id: number
  title: string
  body?: string
  tone: 'info' | 'success' | 'warning' | 'danger'
}

interface StoreValue {
  route: AppRoute
  navigate: (route: AppRoute) => void

  hardware: HardwareSnapshot | null
  hardwareError: string | null
  hardwareLoading: boolean
  refreshHardware: () => Promise<void>

  inventory: DriverInventory | null
  inventoryLoading: boolean
  refreshInventory: (force?: boolean) => Promise<void>

  scan: ScanResult | null
  scanProgress: ScanProgress | null
  scanning: boolean
  runScan: () => Promise<void>

  health: HealthReport | null
  healthLoading: boolean
  refreshHealth: () => Promise<void>

  settings: AppSettings | null
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>

  samples: MonitorSample[]
  latest: MonitorSample | null
  capabilities: MonitorCapabilities | null
  monitoring: boolean
  startMonitor: () => Promise<void>
  stopMonitor: () => Promise<void>

  toasts: Toast[]
  toast: (toast: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void
}

const StoreContext = createContext<StoreValue | null>(null)

const SAMPLE_CAPACITY = 90

export function StoreProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<AppRoute>('home')

  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null)
  const [hardwareError, setHardwareError] = useState<string | null>(null)
  const [hardwareLoading, setHardwareLoading] = useState(true)

  const [inventory, setInventory] = useState<DriverInventory | null>(null)
  const [inventoryLoading, setInventoryLoading] = useState(true)

  const [scan, setScan] = useState<ScanResult | null>(null)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
  const [scanning, setScanning] = useState(false)

  const [health, setHealth] = useState<HealthReport | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)

  const [settings, setSettings] = useState<AppSettings | null>(null)

  const [samples, setSamples] = useState<MonitorSample[]>([])
  const [capabilities, setCapabilities] = useState<MonitorCapabilities | null>(null)
  const [monitoring, setMonitoring] = useState(false)

  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(1)

  const toast = useCallback((next: Omit<Toast, 'id'>) => {
    const id = toastId.current++
    setToasts((previous) => [...previous.slice(-3), { ...next, id }])
    // Failures stay long enough to read; confirmations get out of the way.
    const lifetime = next.tone === 'danger' ? 12_000 : next.tone === 'warning' ? 9000 : 5500
    setTimeout(() => setToasts((previous) => previous.filter((item) => item.id !== id)), lifetime)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((previous) => previous.filter((item) => item.id !== id))
  }, [])

  const navigate = useCallback((next: AppRoute) => {
    setRoute(next)
    document.querySelector('.main')?.scrollTo({ top: 0, behavior: 'auto' })
  }, [])

  const refreshHardware = useCallback(async () => {
    setHardwareLoading(true)
    setHardwareError(null)
    try {
      setHardware(await api.hardware.refresh())
    } catch (error) {
      setHardwareError(errorMessage(error))
    } finally {
      setHardwareLoading(false)
    }
  }, [])

  const refreshInventory = useCallback(async (force = false) => {
    setInventoryLoading(true)
    try {
      setInventory(await api.drivers.inventory(force))
    } catch (error) {
      toast({ title: 'Could not read installed drivers', body: errorMessage(error), tone: 'danger' })
    } finally {
      setInventoryLoading(false)
    }
  }, [toast])

  const refreshHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      setHealth(await api.health.report())
    } catch (error) {
      toast({ title: 'Health check failed', body: errorMessage(error), tone: 'danger' })
    } finally {
      setHealthLoading(false)
    }
  }, [toast])

  const runScan = useCallback(async () => {
    if (scanning) return
    setScanning(true)
    setScanProgress({ phase: 'hardware', label: 'Starting scan', step: 0, totalSteps: 5 })
    try {
      const result = await api.drivers.scan()
      setScan(result)
      const actionable = result.updates.filter(
        (update) => update.classification === 'critical' || update.classification === 'recommended'
      )
      const failedSources = result.sources.filter((source) => source.state === 'error')
      toast({
        title: actionable.length === 0 ? 'Scan complete — nothing needs attention' : `${actionable.length} update(s) worth taking`,
        body:
          failedSources.length > 0
            ? `${failedSources.length} source(s) could not be reached: ${failedSources.map((s) => s.label).join(', ')}.`
            : `Checked ${result.sources.filter((s) => s.state === 'ok').length} official source(s).`,
        tone: failedSources.length > 0 ? 'warning' : actionable.length > 0 ? 'info' : 'success'
      })
      void refreshInventory(false)
      void refreshHealth()
    } catch (error) {
      toast({ title: 'Driver scan failed', body: errorMessage(error), tone: 'danger' })
    } finally {
      setScanning(false)
      setScanProgress(null)
    }
  }, [scanning, toast, refreshInventory, refreshHealth])

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        const next = await api.settings.set(patch)
        setSettings(next)
        document.documentElement.dataset['theme'] = next.theme
      } catch (error) {
        toast({ title: 'Could not save settings', body: errorMessage(error), tone: 'danger' })
      }
    },
    [toast]
  )

  const startMonitor = useCallback(async () => {
    try {
      setCapabilities(await api.monitor.start())
      setMonitoring(true)
    } catch (error) {
      toast({ title: 'Could not start monitoring', body: errorMessage(error), tone: 'danger' })
    }
  }, [toast])

  const stopMonitor = useCallback(async () => {
    try {
      await api.monitor.stop()
    } catch {
      /* stopping is best-effort */
    }
    setMonitoring(false)
  }, [])

  // Initial load and subscriptions.
  useEffect(() => {
    void (async () => {
      try {
        const loaded = await api.settings.get()
        setSettings(loaded)
        document.documentElement.dataset['theme'] = loaded.theme
      } catch {
        /* defaults are applied in main */
      }

      setHardwareLoading(true)
      try {
        setHardware(await api.hardware.get())
      } catch (error) {
        setHardwareError(errorMessage(error))
      } finally {
        setHardwareLoading(false)
      }

      setInventoryLoading(true)
      try {
        setInventory(await api.drivers.inventory(false))
      } catch {
        /* surfaced on the Drivers screen */
      } finally {
        setInventoryLoading(false)
      }

      try {
        setCapabilities(await api.monitor.capabilities())
      } catch {
        /* capabilities are optional until the monitor starts */
      }
    })()

    const offScan = api.on.scanProgress(setScanProgress)
    const offSample = api.on.monitorSample((sample) => {
      setSamples((previous) => {
        const next = previous.length >= SAMPLE_CAPACITY ? previous.slice(previous.length - SAMPLE_CAPACITY + 1) : previous.slice()
        next.push(sample)
        return next
      })
    })
    const offNotification = api.on.notification((notification) => {
      toast({ title: notification.title, body: notification.body, tone: notification.tone })
    })
    const offNavigate = api.on.navigate((next) => setRoute(next as AppRoute))

    return () => {
      offScan()
      offSample()
      offNotification()
      offNavigate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const latest = samples.length > 0 ? (samples[samples.length - 1] ?? null) : null

  const value = useMemo<StoreValue>(
    () => ({
      route,
      navigate,
      hardware,
      hardwareError,
      hardwareLoading,
      refreshHardware,
      inventory,
      inventoryLoading,
      refreshInventory,
      scan,
      scanProgress,
      scanning,
      runScan,
      health,
      healthLoading,
      refreshHealth,
      settings,
      saveSettings,
      samples,
      latest,
      capabilities,
      monitoring,
      startMonitor,
      stopMonitor,
      toasts,
      toast,
      dismissToast
    }),
    [
      route,
      navigate,
      hardware,
      hardwareError,
      hardwareLoading,
      refreshHardware,
      inventory,
      inventoryLoading,
      refreshInventory,
      scan,
      scanProgress,
      scanning,
      runScan,
      health,
      healthLoading,
      refreshHealth,
      settings,
      saveSettings,
      samples,
      latest,
      capabilities,
      monitoring,
      startMonitor,
      stopMonitor,
      toasts,
      toast,
      dismissToast
    ]
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext)
  if (!value) throw new Error('useStore must be used inside StoreProvider')
  return value
}
