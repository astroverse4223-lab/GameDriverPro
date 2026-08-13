import { useEffect, useMemo } from 'react'
import { useStore } from '../lib/store'
import { Badge, Bar, Button, Empty, Note, Panel, Ring, Stat, StateIcon, StatusDot } from '../components/ui'
import { Sparkline } from '../components/Chart'
import { IconBolt, IconChevron, IconChip, IconGamepad, IconPulse, IconRefresh, IconSearch, IconShield } from '../components/Icons'
import { bytes, gigabytes, linkSpeed, percent, relative, temperature, text, DASH } from '../lib/format'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import type { DriverCategory } from '../../shared/types'

/**
 * The dashboard: is this PC ready to game, right now?
 *
 * Everything on this screen is either measured or explicitly marked as not yet
 * known. The status headline is derived from the health report, and until a scan
 * has run it says "not checked yet" rather than "all good".
 */

const CATEGORY_ROWS: { id: DriverCategory; label: string }[] = [
  { id: 'graphics', label: 'GPU driver' },
  { id: 'chipset', label: 'Chipset' },
  { id: 'audio', label: 'Audio' },
  { id: 'network', label: 'Network' },
  { id: 'wifi', label: 'Wi-Fi' },
  { id: 'bluetooth', label: 'Bluetooth' },
  { id: 'storage', label: 'Storage' }
]

export function HomePage() {
  const {
    hardware,
    hardwareLoading,
    hardwareError,
    inventory,
    scan,
    scanning,
    scanProgress,
    runScan,
    health,
    healthLoading,
    refreshHealth,
    navigate,
    samples,
    latest,
    monitoring,
    startMonitor
  } = useStore()

  const games = useAsync(() => api.games.list(false), [])

  // The dashboard's live tiles are worth a monitor; it stops when the app closes.
  useEffect(() => {
    if (!monitoring) void startMonitor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!health && !healthLoading && hardware) void refreshHealth()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardware])

  // The snapshot is already ordered discrete-GPU-first. Match the telemetry
  // sample by name so a name and a utilisation figure can never come from two
  // different adapters.
  const gpu = hardware?.gpus[0] ?? null
  const gpuSample = latest?.gpus.find((sample) => sample.name === gpu?.name) ?? latest?.gpus[0] ?? null

  const actionable = scan?.updates.filter((u) => u.classification === 'critical' || u.classification === 'recommended') ?? []
  const criticalCount = scan?.updates.filter((u) => u.classification === 'critical').length ?? 0
  const problemDevices = inventory?.problemDevices ?? 0

  const headline = useMemo(() => {
    if (hardwareError) return { title: 'Detection failed', tone: 'bad' as const, sub: hardwareError }
    if (!hardware) return { title: 'Reading your PC…', tone: 'muted' as const, sub: 'Querying Windows for hardware and drivers.' }
    if (problemDevices > 0) {
      return {
        title: 'Attention needed',
        tone: 'bad' as const,
        sub: `Windows reports a problem with ${problemDevices} device${problemDevices === 1 ? '' : 's'}. That usually means a driver is missing or has failed to start.`
      }
    }
    if (criticalCount > 0) {
      return {
        title: 'Update recommended',
        tone: 'warn' as const,
        sub: `${criticalCount} driver update${criticalCount === 1 ? '' : 's'} classed as important for this PC.`
      }
    }
    if (!scan) {
      return {
        title: 'PC detected',
        tone: 'info' as const,
        sub: 'Hardware and installed drivers are known. Run a scan to check them against official manufacturer sources — until then, no claim is made about whether they are current.'
      }
    }
    if (actionable.length > 0) {
      return {
        title: 'Ready, with suggestions',
        tone: 'warn' as const,
        sub: `${actionable.length} recommended update${actionable.length === 1 ? '' : 's'} available. Nothing is blocking you from playing.`
      }
    }
    return {
      title: 'System ready',
      tone: 'ok' as const,
      sub: 'Drivers match the newest versions the official sources report, and Windows reports no device problems.'
    }
  }, [hardware, hardwareError, problemDevices, criticalCount, scan, actionable.length])

  const cpuSeries = samples.map((s) => s.cpu.usagePercent)
  const gpuSeries = samples.map((s) => s.gpus[0]?.usagePercent ?? null)
  const memSeries = samples.map((s) => s.memory.usagePercent)

  const primaryVolume = hardware?.storage
    .flatMap((disk) => disk.volumes)
    .find((volume) => volume.letter?.toUpperCase() === 'C') ?? hardware?.storage[0]?.volumes[0] ?? null

  const activeAdapter = hardware?.network.find((a) => a.status === 'Up' && !a.isVirtual) ?? null

  return (
    <div className="page">
      {/* ------------------------------------------------------------ hero */}
      <section className="hero">
        <div>
          <div className="eyebrow">PC Status</div>
          <div className="hero__status" style={{ marginTop: 8 }}>
            <StatusDot tone={headline.tone} pulse={headline.tone !== 'ok'} />
            {headline.title}
          </div>
          <p className="hero__sub">{headline.sub}</p>

          <div className="hero__actions">
            <Button variant="primary" size="lg" loading={scanning} icon={<IconSearch size={16} />} onClick={() => void runScan()}>
              {scanning ? 'Scanning…' : 'Scan my PC'}
            </Button>
            <Button size="lg" icon={<IconBolt size={16} />} onClick={() => navigate('boost')}>
              Boost game
            </Button>
            <Button variant="ghost" size="lg" icon={<IconPulse size={16} />} onClick={() => navigate('performance')}>
              Live performance
            </Button>
          </div>

          {scanning && scanProgress && (
            <div style={{ marginTop: 20, maxWidth: 460 }}>
              <div className="split small muted" style={{ marginBottom: 7 }}>
                <span>{scanProgress.label}</span>
                <span className="right mono">
                  {scanProgress.step}/{scanProgress.totalSteps}
                </span>
              </div>
              <Bar value={(scanProgress.step / Math.max(1, scanProgress.totalSteps)) * 100} />
            </div>
          )}
        </div>

        <div className="hero__score">
          {health ? (
            <Ring value={health.score} caption="Gaming health" size={176} />
          ) : (
            <Ring value={0} label={healthLoading ? '…' : '?'} caption="Not checked" size={176} />
          )}
          <div className="small faint" style={{ maxWidth: 170, textAlign: 'center', marginTop: 6 }}>
            {health
              ? `${health.evaluatedChecks} of ${health.checks.length} checks could be evaluated`
              : 'Run a check to score this PC'}
          </div>
        </div>
      </section>

      {hardwareError && (
        <Note tone="bad">
          <strong>Hardware detection failed.</strong> {hardwareError}
        </Note>
      )}

      {/* ------------------------------------------------------- live tiles */}
      <div className="grid grid--4">
        <Stat
          label={<><IconChip size={13} /> GPU</>}
          value={gpuSample?.usagePercent !== null && gpuSample?.usagePercent !== undefined ? Math.round(gpuSample.usagePercent) : DASH}
          unit={gpuSample?.usagePercent !== null && gpuSample?.usagePercent !== undefined ? '%' : undefined}
          live
          tone="info"
          meta={
            gpu ? (
              <span title={gpu.name}>
                {gpu.name.replace(/^NVIDIA |^AMD |^Intel\(R\) /, '')} ·{' '}
                {gpu.displayDriverVersion ?? text(gpu.driverVersion)}
              </span>
            ) : (
              'No GPU detected'
            )
          }
        >
          {gpuSeries.some((v) => v !== null) && <Sparkline values={gpuSeries} color="#22d3ee" max={100} />}
        </Stat>


        <Stat
          label="CPU"
          value={latest?.cpu.usagePercent !== null && latest?.cpu.usagePercent !== undefined ? Math.round(latest.cpu.usagePercent) : DASH}
          unit={latest?.cpu.usagePercent !== null && latest?.cpu.usagePercent !== undefined ? '%' : undefined}
          live
          tone="brand"
          meta={
            <>
              {hardware?.cpu.name.replace(/\(R\)|\(TM\)|CPU|@.*/g, '').trim() ?? DASH}
              {latest?.cpu.temperatureC !== null && latest?.cpu.temperatureC !== undefined
                ? ` · ${temperature(latest.cpu.temperatureC)}`
                : ''}
            </>
          }
        >
          {cpuSeries.some((v) => v !== null) && <Sparkline values={cpuSeries} color="#8b5cf6" max={100} />}
        </Stat>

        <Stat
          label="Memory"
          value={latest ? gigabytes(latest.memory.usedBytes, 1).replace(' GB', '') : gigabytes(hardware?.memory.usedBytes, 1).replace(' GB', '')}
          unit={`/ ${gigabytes(hardware?.memory.totalBytes ?? latest?.memory.totalBytes, 0)}`}
          live
          meta={
            hardware
              ? `${hardware.memory.slotsUsed} of ${hardware.memory.slotsTotal ?? '?'} slots · ${
                  hardware.memory.modules[0]?.formFactor ?? 'unknown type'
                }`
              : DASH
          }
        >
          {memSeries.length > 1 && <Sparkline values={memSeries} color="#a3e635" max={100} />}
        </Stat>

        <Stat
          label="Storage"
          value={primaryVolume ? gigabytes(primaryVolume.freeBytes, 0).replace(' GB', '') : DASH}
          unit={primaryVolume ? `free / ${gigabytes(primaryVolume.totalBytes, 0)}` : undefined}
          meta={
            primaryVolume
              ? `${primaryVolume.letter ?? '?'}: ${text(primaryVolume.fileSystem)} · ${hardware?.storage.length ?? 0} drive(s)`
              : 'No volumes reported'
          }
          tone={
            primaryVolume && primaryVolume.totalBytes && primaryVolume.freeBytes !== null
              ? primaryVolume.freeBytes / primaryVolume.totalBytes < 0.1
                ? 'warn'
                : 'muted'
              : 'muted'
          }
        />
      </div>

      <div className="grid grid--2">
        {/* ------------------------------------------------ driver status */}
        <Panel
          title="Driver status"
          icon={<IconShield size={15} />}
          note={
            scan
              ? `Last checked ${relative(scan.finishedAt)} against ${scan.sources.filter((s) => s.state === 'ok').length} official source(s)`
              : 'Not yet checked against official sources'
          }
          actions={
            <Button variant="ghost" icon={<IconChevron size={14} />} onClick={() => navigate('drivers')}>
              Open
            </Button>
          }
          flush
        >
          <div className="rows" style={{ marginTop: 14 }}>
            {CATEGORY_ROWS.map(({ id, label }) => {
              const entries = inventory?.entries.filter((entry) => entry.category === id) ?? []
              const primary = entries.find((e) => e.driverProvider && !/^microsoft$/i.test(e.driverProvider)) ?? entries[0] ?? null
              const problem = entries.some((e) => e.status === 'error')
              const update = scan?.updates.find((u) => u.category === id && u.availableVersion !== null)
              const important = update?.classification === 'critical' || update?.classification === 'recommended'

              if (!primary) {
                return (
                  <div className="row" key={id} style={{ ['--row-cols' as string]: '1fr auto' }}>
                    <div className="row__main">
                      <div className="row__title muted">{label}</div>
                      <div className="row__sub">No device in this category</div>
                    </div>
                    <Badge tone="muted">None</Badge>
                  </div>
                )
              }

              return (
                <div className="row" key={id} style={{ ['--row-cols' as string]: '1fr auto' }}>
                  <div className="row__main">
                    <div className="row__title">{label}</div>
                    <div className="row__sub">
                      {primary.deviceName} · {primary.displayVersion ?? text(primary.driverVersion)}
                    </div>
                  </div>
                  {problem ? (
                    <Badge tone="bad">Problem</Badge>
                  ) : important ? (
                    <Badge tone="warn">Update</Badge>
                  ) : scan ? (
                    <Badge tone="ok">Current</Badge>
                  ) : (
                    <Badge tone="muted">Not checked</Badge>
                  )}
                </div>
              )
            })}
          </div>
        </Panel>

        {/* ------------------------------------------------ gaming readiness */}
        <Panel
          title="Gaming readiness"
          icon={<IconGamepad size={15} />}
          note={health?.summary ?? 'Run a check to evaluate this PC'}
          actions={
            <Button variant="ghost" loading={healthLoading} icon={<IconRefresh size={14} />} onClick={() => void refreshHealth()}>
              Re-check
            </Button>
          }
        >
          {health ? (
            <>
              <div className="split" style={{ marginBottom: 16 }}>
                <div style={{ flex: 1 }}>
                  <Bar
                    value={health.score}
                    tone={health.score >= 85 ? 'ok' : health.score >= 65 ? 'warn' : 'bad'}
                  />
                </div>
                <span className="mono" style={{ fontSize: 20, fontWeight: 650 }}>
                  {health.score}%
                </span>
              </div>

              <div className="stack stack--sm">
                {health.checks.slice(0, 6).map((check) => (
                  <button
                    key={check.id}
                    className="split"
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '7px 0',
                      borderBottom: '1px solid var(--line)',
                      cursor: check.route ? 'pointer' : 'default'
                    }}
                    onClick={() => check.route && navigate(check.route)}
                  >
                    <StateIcon state={check.state} />
                    <span style={{ fontSize: 13 }}>{check.label}</span>
                    <span className="right small faint" style={{ maxWidth: '52%', textAlign: 'right' }}>
                      {check.state === 'pass' ? 'OK' : check.state === 'unknown' ? 'Not evaluated' : check.problem}
                    </span>
                  </button>
                ))}
              </div>

              {health.checks.filter((c) => c.state !== 'pass' && c.state !== 'unknown').length > 0 && (
                <div className="small faint" style={{ marginTop: 12 }}>
                  {health.checks.filter((c) => c.state !== 'pass' && c.state !== 'unknown').length} recommended action(s) —
                  open a row for the reasoning.
                </div>
              )}
            </>
          ) : healthLoading ? (
            <div className="stack stack--sm">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="skeleton" style={{ height: 30 }} />
              ))}
            </div>
          ) : (
            <Empty
              icon={<IconShield size={20} />}
              title="No health check yet"
              body="GameDriver Pro will not score a PC it has not measured. Run the check to evaluate drivers, storage, memory, crash history and network."
              action={
                <Button variant="primary" onClick={() => void refreshHealth()}>
                  Run health check
                </Button>
              }
            />
          )}
        </Panel>
      </div>

      {/* ---------------------------------------------------------- summary */}
      <div className="grid grid--4">
        <Stat
          label="Drivers"
          value={inventory?.entries.length ?? (hardwareLoading ? '…' : DASH)}
          meta={
            inventory
              ? `${actionable.length} update(s) worth taking · ${inventory.problemDevices} problem device(s)`
              : 'Reading driver inventory'
          }
          tone={problemDevices > 0 ? 'bad' : actionable.length > 0 ? 'warn' : 'muted'}
        />
        <Stat
          label="Games"
          value={games.data?.games.length ?? (games.loading ? '…' : DASH)}
          meta={
            games.data
              ? `${games.data.launchers.filter((l) => l.detected).length} launcher(s) detected`
              : (games.error ?? 'Scanning launchers')
          }
        />
        <Stat
          label="Network"
          value={activeAdapter ? linkSpeed(activeAdapter.linkSpeedBps).replace(/ (Gb|Mb)\/s/, '') : DASH}
          unit={activeAdapter?.linkSpeedBps ? (activeAdapter.linkSpeedBps >= 1e9 ? 'Gb/s' : 'Mb/s') : undefined}
          meta={activeAdapter ? `${activeAdapter.name} · ${text(activeAdapter.ipv4)}` : 'No adapter connected'}
        />
        <Stat
          label="Frame rate"
          value={DASH}
          meta="Not measured — see Performance"
          tone="muted"
        />
      </div>

      <Note>
        Frame rate is not shown anywhere in this app unless something actually measured it. Reading a game's frame timing
        requires hooking its presentation layer, which GameDriver Pro does not do — so it reports no FPS rather than an
        invented one. Everything else on this screen comes from Windows' own APIs and your GPU driver.
      </Note>
    </div>
  )
}
