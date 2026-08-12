import { app } from 'electron'
import { release, totalmem } from 'node:os'
import { store } from './db'
import { monitor } from './monitor'
import { cachedHardware } from './hardware'
import { cachedInventory } from './drivers'
import { nvidiaSmiAvailable } from './nvidia'
import { isElevated } from './elevation'
import { log } from './logger'
import type { Diagnostics, SourceStatus } from '../../shared/types'

/** Developer mode payload — the honest inventory of what is and is not working. */
export async function buildDiagnostics(
  sources: SourceStatus[],
  ipc: { channels: number; callsHandled: number; errors: number }
): Promise<Diagnostics> {
  const hardware = cachedHardware()
  const inventory = cachedInventory()
  const nvidia = await nvidiaSmiAvailable()

  return {
    versions: {
      app: app.getVersion(),
      electron: process.versions['electron'] ?? 'unknown',
      chrome: process.versions['chrome'] ?? 'unknown',
      node: process.versions['node'] ?? 'unknown',
      v8: process.versions['v8'] ?? 'unknown',
      os: `${hardware?.system.osCaption ?? 'Windows'} ${hardware?.system.osVersion ?? release()} (build ${hardware?.system.osBuild ?? '?'})`
    },
    database: store.status(),
    ipc,
    sources,
    capabilities: monitor.getCapabilities(),
    hardwareApis: [
      {
        name: 'WMI / CIM (Win32_*)',
        ok: hardware !== null,
        detail: hardware ? `Snapshot captured ${new Date(hardware.capturedAt).toLocaleTimeString()}` : 'No snapshot captured yet'
      },
      {
        name: 'Win32_PnPSignedDriver',
        ok: (inventory?.entries.length ?? 0) > 0,
        detail: inventory ? `${inventory.entries.length} driver packages` : 'Not read yet'
      },
      {
        name: 'nvidia-smi',
        ok: nvidia,
        detail: nvidia ? 'Available — GPU telemetry active' : 'Not present (no NVIDIA driver, or not on PATH)'
      },
      {
        name: 'Storage reliability counters (SMART)',
        ok: (hardware?.storage ?? []).some((disk) => disk.health.available),
        detail: (hardware?.storage ?? []).some((disk) => disk.health.available)
          ? 'Reporting temperature and wear'
          : 'Not exposed — usually needs administrator rights'
      },
      {
        name: 'Process elevation',
        ok: isElevated(),
        detail: isElevated()
          ? 'Elevated — driver install, restore points and driver export are available'
          : 'Not elevated — driver install, restore points and driver export are unavailable'
      },
      {
        name: 'Windows Update Agent',
        ok: sources.some((source) => source.id === 'windows-update' && source.state === 'ok'),
        detail: sources.find((source) => source.id === 'windows-update')?.detail ?? 'Not queried yet'
      }
    ],
    memoryBytes: process.memoryUsage().rss,
    uptimeSeconds: Math.round(process.uptime()),
    logTail: log.tail(150)
  }
}

export function systemMemoryBytes(): number {
  return totalmem()
}
