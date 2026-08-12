import { useMemo } from 'react'
import { useStore } from '../lib/store'
import { Badge, Bar, Button, Note, Panel, Stat } from '../components/ui'
import { Chart } from '../components/Chart'
import { GameDoctor } from '../components/GameDoctor'
import { IconPause, IconPulse } from '../components/Icons'
import { bitsPerSecond, bytes, gigabytes, megahertz, percent, temperature, watts, DASH } from '../lib/format'

/**
 * Live performance monitor.
 *
 * Charts break where a sensor stops reporting rather than interpolating over the
 * gap, and every panel names the source its numbers came from.
 */

const CAPACITY = 90

export function PerformancePage() {
  const { samples, latest, capabilities, monitoring, startMonitor, stopMonitor, hardware, settings } = useStore()

  const cpuSeries = useMemo(() => samples.map((s) => s.cpu.usagePercent), [samples])
  const gpuSeries = useMemo(() => samples.map((s) => s.gpus[0]?.usagePercent ?? null), [samples])
  const memSeries = useMemo(() => samples.map((s) => s.memory.usagePercent), [samples])
  const tempSeries = useMemo(() => samples.map((s) => s.gpus[0]?.temperatureC ?? null), [samples])
  const powerSeries = useMemo(() => samples.map((s) => s.gpus[0]?.powerWatts ?? null), [samples])
  const netRx = useMemo(() => samples.map((s) => (s.network.rxBytesPerSec === null ? null : (s.network.rxBytesPerSec * 8) / 1_000_000)), [samples])
  const netTx = useMemo(() => samples.map((s) => (s.network.txBytesPerSec === null ? null : (s.network.txBytesPerSec * 8) / 1_000_000)), [samples])
  const diskSeries = useMemo(
    () =>
      samples.map((s) =>
        s.disk.readBytesPerSec === null && s.disk.writeBytesPerSec === null
          ? null
          : ((s.disk.readBytesPerSec ?? 0) + (s.disk.writeBytesPerSec ?? 0)) / 1_048_576
      ),
    [samples]
  )

  const gpu = latest?.gpus[0] ?? null
  const vramRatio = gpu?.vramUsedBytes && gpu.vramTotalBytes ? (gpu.vramUsedBytes / gpu.vramTotalBytes) * 100 : null

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Telemetry</div>
          <h1 className="page__title">Performance</h1>
          <p className="page__sub">
            Sampled every {settings?.monitorIntervalMs ?? 1000} ms. {samples.length} of {CAPACITY} samples in the window.
            {capabilities?.gpuTelemetrySource === 'nvidia-smi'
              ? ' GPU data comes from nvidia-smi, which ships with your display driver.'
              : capabilities?.gpuTelemetrySource === 'perf-counters'
                ? ' GPU load comes from Windows GPU engine counters — temperature, clocks and power are not available from that source.'
                : ''}
          </p>
        </div>
        <div className="split">
          {monitoring ? (
            <Button icon={<IconPause size={15} />} onClick={() => void stopMonitor()}>
              Pause monitoring
            </Button>
          ) : (
            <Button variant="primary" icon={<IconPulse size={15} />} onClick={() => void startMonitor()}>
              Start monitoring
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid--4">
        <Stat
          label="CPU"
          value={latest?.cpu.usagePercent === null || latest === null ? DASH : Math.round(latest.cpu.usagePercent)}
          unit={latest?.cpu.usagePercent === null || latest === null ? undefined : '%'}
          live
          tone="brand"
          meta={
            latest?.cpu.temperatureC !== null && latest?.cpu.temperatureC !== undefined
              ? `${temperature(latest.cpu.temperatureC)} · ${megahertz(latest.cpu.clockMhz)}`
              : `Temperature not exposed · ${megahertz(hardware?.cpu.maxClockMhz)}`
          }
        />
        <Stat
          label="GPU"
          value={gpu?.usagePercent === null || !gpu ? DASH : Math.round(gpu.usagePercent)}
          unit={gpu?.usagePercent === null || !gpu ? undefined : '%'}
          live
          tone="info"
          meta={
            gpu
              ? [
                  gpu.temperatureC === null ? null : temperature(gpu.temperatureC),
                  gpu.powerWatts === null ? null : watts(gpu.powerWatts),
                  gpu.temperatureC === null && gpu.powerWatts === null ? 'thermals not reported' : null
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'No GPU telemetry'
          }
        />
        <Stat
          label="Video memory"
          value={gpu?.vramUsedBytes ? gigabytes(gpu.vramUsedBytes).replace(' GB', '') : DASH}
          unit={gpu?.vramTotalBytes ? `/ ${gigabytes(gpu.vramTotalBytes, 0)}` : undefined}
          live
          tone={vramRatio !== null && vramRatio > 90 ? 'warn' : 'muted'}
          meta={vramRatio === null ? 'Not reported by this GPU' : `${Math.round(vramRatio)}% of dedicated memory`}
        />
        <Stat
          label="Memory"
          value={latest ? gigabytes(latest.memory.usedBytes).replace(' GB', '') : DASH}
          unit={latest ? `/ ${gigabytes(latest.memory.totalBytes, 0)}` : undefined}
          live
          meta={latest ? `${percent(latest.memory.usagePercent, 1)} in use` : ''}
        />
      </div>

      {!monitoring && samples.length === 0 && (
        <Note>
          Monitoring is not running, so there is nothing to plot. Start it to sample CPU, GPU, memory, disk and network from
          Windows and your display driver.
        </Note>
      )}

      <div className="grid grid--pair">
        <Panel title="Load" note="CPU and GPU utilisation, %">
          <Chart
            capacity={CAPACITY}
            yMax={100}
            series={[
              { label: 'CPU', color: '#8b5cf6', values: cpuSeries },
              { label: 'GPU', color: '#22d3ee', values: gpuSeries }
            ]}
          />
          <div className="chart__legend">
            <span>
              <i style={{ background: '#8b5cf6' }} />
              CPU {latest?.cpu.usagePercent === null || !latest ? DASH : `${latest.cpu.usagePercent.toFixed(0)}%`}
            </span>
            <span>
              <i style={{ background: '#22d3ee' }} />
              GPU {gpu?.usagePercent === null || !gpu ? DASH : `${gpu.usagePercent.toFixed(0)}%`}
            </span>
          </div>
        </Panel>

        <Panel title="Memory" note="System memory in use, %">
          <Chart capacity={CAPACITY} yMax={100} series={[{ label: 'RAM', color: '#a3e635', values: memSeries }]} />
          <div className="chart__legend">
            <span>
              <i style={{ background: '#a3e635' }} />
              {latest ? `${gigabytes(latest.memory.usedBytes)} of ${gigabytes(latest.memory.totalBytes, 0)}` : DASH}
            </span>
          </div>
        </Panel>

        <Panel
          title="GPU thermals and power"
          note={
            capabilities?.gpuTelemetrySource === 'nvidia-smi'
              ? 'Temperature (°C) and board power (W) from nvidia-smi'
              : 'Not available from Windows GPU counters'
          }
        >
          {tempSeries.some((v) => v !== null) || powerSeries.some((v) => v !== null) ? (
            <>
              <Chart
                capacity={CAPACITY}
                unit=""
                series={[
                  { label: 'Temp', color: '#fb7185', values: tempSeries },
                  { label: 'Power', color: '#fbbf24', values: powerSeries, fill: false }
                ]}
              />
              <div className="chart__legend">
                <span>
                  <i style={{ background: '#fb7185' }} />
                  Temperature {temperature(gpu?.temperatureC)}
                </span>
                <span>
                  <i style={{ background: '#fbbf24' }} />
                  {gpu?.powerWatts !== null && gpu?.powerWatts !== undefined
                    ? `Power ${watts(gpu.powerWatts)}${gpu.powerLimitWatts ? ` of ${watts(gpu.powerLimitWatts)}` : ''}`
                    : `Power not reported by this GPU${gpu?.powerLimitWatts ? ` (limit ${watts(gpu.powerLimitWatts)})` : ''}`}
                </span>
                {gpu?.fanPercent !== null && gpu?.fanPercent !== undefined && <span>Fan {percent(gpu.fanPercent)}</span>}
              </div>
            </>
          ) : (
            <Note tone="plain">
              This GPU does not expose temperature or power to Windows through a source GameDriver Pro can read. Rather than
              show a plausible-looking curve, the chart stays empty.
            </Note>
          )}
        </Panel>

        <Panel title="Disk and network" note="Total disk throughput (MB/s) and network (Mbps)">
          <Chart
            capacity={CAPACITY}
            unit=""
            series={[
              { label: 'Disk MB/s', color: '#38bdf8', values: diskSeries },
              { label: 'Down Mbps', color: '#4ade80', values: netRx, fill: false },
              { label: 'Up Mbps', color: '#c084fc', values: netTx, fill: false }
            ]}
          />
          <div className="chart__legend">
            <span>
              <i style={{ background: '#38bdf8' }} />
              Disk {latest ? bytes((latest.disk.readBytesPerSec ?? 0) + (latest.disk.writeBytesPerSec ?? 0)) : DASH}/s
            </span>
            <span>
              <i style={{ background: '#4ade80' }} />
              Down {bitsPerSecond(latest?.network.rxBytesPerSec)}
            </span>
            <span>
              <i style={{ background: '#c084fc' }} />
              Up {bitsPerSecond(latest?.network.txBytesPerSec)}
            </span>
            {latest?.disk.activePercent !== null && latest?.disk.activePercent !== undefined && (
              <span>Disk busy {percent(latest.disk.activePercent)}</span>
            )}
          </div>
        </Panel>
      </div>

      {gpu && capabilities?.gpuTelemetrySource === 'nvidia-smi' && (
        <Panel title="GPU detail" note={`Reported by nvidia-smi for “${gpu.name}”`}>
          <div className="grid grid--4">
            <Stat label="Core clock" value={megahertz(gpu.coreClockMhz)} meta="current graphics clock" />
            <Stat label="Memory clock" value={megahertz(gpu.memoryClockMhz)} meta="current memory clock" />
            <Stat label="Board power" value={watts(gpu.powerWatts)} meta={gpu.powerLimitWatts ? `limit ${watts(gpu.powerLimitWatts)}` : 'limit not reported'} />
            <Stat label="Fan" value={gpu.fanPercent === null ? DASH : percent(gpu.fanPercent)} meta="driver-reported duty cycle" />
          </div>
          {vramRatio !== null && (
            <div style={{ marginTop: 16 }}>
              <div className="split small" style={{ marginBottom: 6 }}>
                <span>Video memory</span>
                <span className="right mono faint">
                  {gigabytes(gpu.vramUsedBytes)} of {gigabytes(gpu.vramTotalBytes)}
                </span>
              </div>
              <Bar value={vramRatio} tone={vramRatio > 92 ? 'bad' : vramRatio > 82 ? 'warn' : undefined} />
            </div>
          )}
        </Panel>
      )}

      <GameDoctor samples={samples} hardware={hardware} />

      <Panel title="What is and is not measured" note="Sources and limits, stated plainly.">
        <div className="stack">
          <div className="rows">
            {[
              ['CPU utilisation', capabilities?.cpuUsage !== false, 'Per-core time deltas from the OS scheduler.'],
              ['CPU temperature', capabilities?.cpuTemperature === true, 'Only if the motherboard exposes an ACPI thermal zone. Most desktops do not.'],
              [
                'GPU utilisation',
                capabilities?.gpuTelemetry === true,
                capabilities?.gpuTelemetrySource === 'nvidia-smi' ? 'nvidia-smi, bundled with the NVIDIA driver.' : 'Windows GPU engine performance counters.'
              ],
              ['Disk throughput', capabilities?.diskIo !== false, 'Win32_PerfFormattedData_PerfDisk_PhysicalDisk (_Total).'],
              ['Network throughput', capabilities?.networkIo !== false, 'Win32_PerfFormattedData_Tcpip_NetworkInterface, virtual adapters excluded.'],
              ['Frame rate / frame time', false, 'Requires hooking a game’s presentation layer. GameDriver Pro does not do this, so it reports no FPS at all.']
            ].map(([label, available, detail]) => (
              <div className="row" key={String(label)} style={{ padding: '11px 0', ['--row-cols' as string]: '1fr auto' }}>
                <div className="row__main">
                  <div className="row__title">{String(label)}</div>
                  <div className="row__sub">{String(detail)}</div>
                </div>
                <Badge tone={available ? 'ok' : 'muted'}>{available ? 'Measured' : 'Not available'}</Badge>
              </div>
            ))}
          </div>
          {capabilities?.notes.map((note, index) => (
            <Note key={index} tone="plain">
              {note}
            </Note>
          ))}
        </div>
      </Panel>
    </div>
  )
}
