import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cpus, totalmem, freemem } from 'node:os'
import { PowerShellStream } from './powershell'
import { parseNvidiaCsvLine, nvidiaSmiAvailable, NVIDIA_QUERY_FIELDS, type NvidiaGpuReading } from './nvidia'
import { cachedHardware } from './hardware'
import { log, describeError } from './logger'
import type { GpuSample, MonitorCapabilities, MonitorSample } from '../../shared/types'

/**
 * Live hardware telemetry.
 *
 * Every value here is measured:
 *  - CPU load comes from per-core jiffy deltas (node:os), which costs nothing;
 *  - GPU load, clocks, power, VRAM and temperature come from nvidia-smi, which
 *    ships with the NVIDIA driver, or from the language-neutral GPU performance
 *    counters when the platform has them;
 *  - disk and network throughput come from the Win32_PerfFormattedData CIM
 *    classes (chosen over Get-Counter because counter *names* are localised).
 *
 * Anything the platform will not report stays null. There is no interpolation,
 * no smoothing that invents data, and no FPS number unless something actually
 * measured frames.
 */

const DEFAULT_INTERVAL_MS = 1000
const MIN_INTERVAL_MS = 500

/**
 * One long-lived PowerShell loop for the counters Node cannot read. Spawning a
 * PowerShell process per tick would cost ~150ms of CPU every second; this keeps
 * idle overhead to a single sleeping process.
 */
const TELEMETRY_LOOP = `
$intervalMs = [int]$env:GDP_ARG_INTERVAL
if ($intervalMs -lt 250) { $intervalMs = 1000 }
$wantGpuCounters = ($env:GDP_ARG_GPUCOUNTERS -eq '1')

while ($true) {
  $row = [ordered]@{}

  try {
    $disk = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" -ErrorAction Stop
    if ($disk) {
      $row.diskRead = [int64]$disk.DiskReadBytesPerSec
      $row.diskWrite = [int64]$disk.DiskWriteBytesPerSec
      $row.diskActive = [int]$disk.PercentDiskTime
    }
  } catch { $row.diskRead = $null; $row.diskWrite = $null; $row.diskActive = $null }

  try {
    $rx = 0; $tx = 0
    foreach ($n in @(Get-CimInstance -ClassName Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction Stop)) {
      $name = [string]$n.Name
      if ($name -match 'Loopback|isatap|Teredo|Pseudo') { continue }
      $rx += [int64]$n.BytesReceivedPersec
      $tx += [int64]$n.BytesSentPersec
    }
    $row.netRx = $rx
    $row.netTx = $tx
  } catch { $row.netRx = $null; $row.netTx = $null }

  try {
    $z = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop)
    if ($z.Count -gt 0) {
      $k = [double]$z[0].CurrentTemperature
      $row.cpuTempC = [math]::Round(($k / 10.0) - 273.15, 1)
    } else { $row.cpuTempC = $null }
  } catch { $row.cpuTempC = $null }

  try {
    $p = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop
    if ($p) { $row.cpuClockPct = [int]$p.PercentProcessorTime }
  } catch { $row.cpuClockPct = $null }

  if ($wantGpuCounters) {
    try {
      $util = 0.0
      foreach ($e in @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop)) {
        $util += [double]$e.UtilizationPercentage
      }
      $row.gpuCounterUtil = [math]::Round([math]::Min($util, 100.0), 1)
    } catch { $row.gpuCounterUtil = $null }
    try {
      $dedicated = 0
      foreach ($m in @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction Stop)) {
        $dedicated += [int64]$m.DedicatedUsage
      }
      $row.gpuCounterVram = $dedicated
    } catch { $row.gpuCounterVram = $null }
  }

  Write-Output (ConvertTo-Json -InputObject ([pscustomobject]$row) -Compress)
  Start-Sleep -Milliseconds $intervalMs
}
`

interface CounterRow {
  diskRead?: number | null
  diskWrite?: number | null
  diskActive?: number | null
  netRx?: number | null
  netTx?: number | null
  cpuTempC?: number | null
  cpuClockPct?: number | null
  gpuCounterUtil?: number | null
  gpuCounterVram?: number | null
}

interface CpuTimes {
  idle: number
  total: number
}

function readCpuTimes(): CpuTimes {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }
  return { idle, total }
}

export class MonitorService {
  private timer: NodeJS.Timeout | null = null
  private counterStream: PowerShellStream | null = null
  private nvidiaProcess: ChildProcessWithoutNullStreams | null = null
  private nvidiaBuffer = ''

  private lastCpu: CpuTimes = readCpuTimes()
  private lastAppCpu = process.cpuUsage()
  private lastAppCpuAt = Date.now()

  private counters: CounterRow = {}
  private nvidiaReadings: NvidiaGpuReading[] = []
  private capabilities: MonitorCapabilities = {
    cpuUsage: true,
    cpuTemperature: false,
    gpuTelemetry: false,
    gpuTelemetrySource: 'none',
    diskIo: false,
    networkIo: false,
    fps: false,
    notes: []
  }

  private intervalMs = DEFAULT_INTERVAL_MS
  private subscribers = new Set<(sample: MonitorSample) => void>()

  get running(): boolean {
    return this.timer !== null
  }

  getCapabilities(): MonitorCapabilities {
    return { ...this.capabilities, notes: [...this.capabilities.notes] }
  }

  subscribe(listener: (sample: MonitorSample) => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  async start(intervalMs = DEFAULT_INTERVAL_MS): Promise<MonitorCapabilities> {
    this.intervalMs = Math.max(MIN_INTERVAL_MS, intervalMs)
    if (this.timer) return this.getCapabilities()

    const hasNvidia = await nvidiaSmiAvailable()
    const notes: string[] = []

    this.capabilities = {
      cpuUsage: true,
      cpuTemperature: false,
      gpuTelemetry: hasNvidia,
      gpuTelemetrySource: hasNvidia ? 'nvidia-smi' : 'perf-counters',
      diskIo: true,
      networkIo: true,
      fps: false,
      notes
    }

    if (hasNvidia) {
      this.startNvidiaStream()
      notes.push('GPU telemetry is read from nvidia-smi, which ships with the NVIDIA display driver.')
    } else {
      notes.push(
        'No NVIDIA driver telemetry tool was found. GPU load is estimated from the Windows GPU engine performance counters, which do not report temperature, clocks or power.'
      )
    }
    notes.push(
      'Frame rate and frame times are not measured. Reading those requires hooking a game’s presentation layer, which GameDriver Pro does not do — so it reports no FPS rather than an invented one.'
    )

    this.startCounterStream(!hasNvidia)

    this.lastCpu = readCpuTimes()
    this.lastAppCpu = process.cpuUsage()
    this.lastAppCpuAt = Date.now()

    this.timer = setInterval(() => this.tick(), this.intervalMs)
    log.info('monitor', `Started at ${this.intervalMs}ms (GPU source: ${this.capabilities.gpuTelemetrySource})`)
    return this.getCapabilities()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.counterStream?.stop()
    this.counterStream = null
    this.stopNvidiaStream()
    this.counters = {}
    this.nvidiaReadings = []
    log.info('monitor', 'Stopped')
  }

  private startCounterStream(withGpuCounters: boolean): void {
    this.counterStream = new PowerShellStream(
      TELEMETRY_LOOP,
      (row) => {
        this.counters = row as CounterRow
        if (this.counters.cpuTempC !== null && this.counters.cpuTempC !== undefined) {
          this.capabilities.cpuTemperature = true
        }
      },
      (message) => log.warn('monitor', `Counter stream error: ${message}`)
    )
    const started = this.counterStream.start({
      INTERVAL: String(this.intervalMs),
      GPUCOUNTERS: withGpuCounters ? '1' : '0'
    })
    if (!started) {
      this.capabilities.diskIo = false
      this.capabilities.networkIo = false
      this.capabilities.notes.push('Disk and network counters are unavailable on this system.')
    }
  }

  private startNvidiaStream(): void {
    try {
      const loopSeconds = Math.max(1, Math.round(this.intervalMs / 1000))
      this.nvidiaProcess = spawn(
        'nvidia-smi',
        [`--query-gpu=${NVIDIA_QUERY_FIELDS.join(',')}`, '--format=csv,noheader,nounits', '-l', String(loopSeconds)],
        { windowsHide: true }
      )
      this.nvidiaProcess.stdout.setEncoding('utf8')
      this.nvidiaProcess.stdout.on('data', (chunk: string) => this.consumeNvidia(chunk))
      this.nvidiaProcess.on('error', (error) => {
        log.warn('monitor', `nvidia-smi stream failed: ${error.message}`)
        this.capabilities.gpuTelemetry = false
        this.capabilities.gpuTelemetrySource = 'none'
      })
      this.nvidiaProcess.on('close', () => {
        this.nvidiaProcess = null
      })
    } catch (error) {
      log.warn('monitor', `Could not start nvidia-smi: ${describeError(error)}`)
      this.capabilities.gpuTelemetry = false
      this.capabilities.gpuTelemetrySource = 'none'
    }
  }

  private consumeNvidia(chunk: string): void {
    this.nvidiaBuffer += chunk
    let index = this.nvidiaBuffer.indexOf('\n')
    const batch: NvidiaGpuReading[] = []
    while (index >= 0) {
      const line = this.nvidiaBuffer.slice(0, index).trim()
      this.nvidiaBuffer = this.nvidiaBuffer.slice(index + 1)
      if (line) {
        const reading = parseNvidiaCsvLine(line)
        if (reading) batch.push(reading)
      }
      index = this.nvidiaBuffer.indexOf('\n')
    }
    if (this.nvidiaBuffer.length > 16_000) this.nvidiaBuffer = ''

    if (batch.length > 0) {
      // nvidia-smi emits one line per GPU per interval; merge by index so a
      // multi-GPU machine keeps a complete picture.
      const merged = new Map<number, NvidiaGpuReading>()
      for (const existing of this.nvidiaReadings) merged.set(existing.index, existing)
      for (const reading of batch) merged.set(reading.index, reading)
      this.nvidiaReadings = [...merged.values()].sort((a, b) => a.index - b.index)
    }
  }

  private stopNvidiaStream(): void {
    if (!this.nvidiaProcess) return
    const child = this.nvidiaProcess
    this.nvidiaProcess = null
    this.nvidiaBuffer = ''
    try {
      child.kill()
    } catch {
      /* already exited */
    }
  }

  private buildGpuSamples(): GpuSample[] {
    if (this.nvidiaReadings.length > 0) {
      return this.nvidiaReadings.map((reading) => ({
        index: reading.index,
        name: reading.name,
        usagePercent: reading.utilizationPercent,
        temperatureC: reading.temperatureC,
        coreClockMhz: reading.coreClockMhz,
        memoryClockMhz: reading.memoryClockMhz,
        powerWatts: reading.powerWatts,
        powerLimitWatts: reading.powerLimitWatts,
        fanPercent: reading.fanPercent,
        vramUsedBytes: reading.vramUsedBytes,
        vramTotalBytes: reading.vramTotalBytes,
        source: 'nvidia-smi'
      }))
    }

    const hardware = cachedHardware()
    const primary = hardware?.gpus[0]
    if (!primary) return []
    const util = this.counters.gpuCounterUtil
    const vram = this.counters.gpuCounterVram
    return [
      {
        index: 0,
        name: primary.name,
        usagePercent: util ?? null,
        temperatureC: null,
        coreClockMhz: null,
        memoryClockMhz: null,
        powerWatts: null,
        powerLimitWatts: null,
        fanPercent: null,
        vramUsedBytes: vram ?? null,
        vramTotalBytes: primary.vramBytes,
        source: util === null || util === undefined ? 'none' : 'perf-counters'
      }
    ]
  }

  private tick(): void {
    const now = readCpuTimes()
    const idleDelta = now.idle - this.lastCpu.idle
    const totalDelta = now.total - this.lastCpu.total
    this.lastCpu = now
    const cpuUsage = totalDelta > 0 ? Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100)) : null

    const appCpu = process.cpuUsage()
    const elapsedUs = Math.max(1, (Date.now() - this.lastAppCpuAt) * 1000)
    const appCpuPercent =
      ((appCpu.user - this.lastAppCpu.user + (appCpu.system - this.lastAppCpu.system)) / elapsedUs) * 100
    this.lastAppCpu = appCpu
    this.lastAppCpuAt = Date.now()

    const total = totalmem()
    const free = freemem()
    const used = Math.max(0, total - free)

    const sample: MonitorSample = {
      t: Date.now(),
      cpu: {
        usagePercent: cpuUsage === null ? null : Math.round(cpuUsage * 10) / 10,
        temperatureC: this.counters.cpuTempC ?? null,
        clockMhz: cachedHardware()?.cpu.maxClockMhz ?? null
      },
      memory: {
        usedBytes: used,
        totalBytes: total,
        usagePercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0
      },
      gpus: this.buildGpuSamples(),
      disk: {
        readBytesPerSec: this.counters.diskRead ?? null,
        writeBytesPerSec: this.counters.diskWrite ?? null,
        activePercent: this.counters.diskActive ?? null
      },
      network: {
        rxBytesPerSec: this.counters.netRx ?? null,
        txBytesPerSec: this.counters.netTx ?? null
      },
      app: {
        cpuPercent: Math.round(Math.max(0, appCpuPercent) * 10) / 10,
        memoryBytes: process.memoryUsage().rss
      }
    }

    for (const listener of this.subscribers) {
      try {
        listener(sample)
      } catch (error) {
        log.warn('monitor', `Subscriber threw: ${describeError(error)}`)
      }
    }
  }
}

export const monitor = new MonitorService()
