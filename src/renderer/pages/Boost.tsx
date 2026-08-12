import { useEffect, useState } from 'react'
import { useStore } from '../lib/store'
import { api, errorMessage } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { Badge, Bar, Button, CheckRow, Empty, Note, Panel, Stat, Tabs } from '../components/ui'
import { IconBolt, IconRefresh } from '../components/Icons'
import { bytes, gigabytes, percent, DASH } from '../lib/format'
import type { BoostResult, ProcessInfo, StartupItem } from '../../shared/types'

/**
 * Game Boost, Gaming Mode, startup and background process analysis.
 *
 * The plan is always shown before anything happens, each line is individually
 * opt-in, and actions Windows does not support are listed as unavailable with the
 * reason rather than quietly dropped. There is no "free up RAM" button, because
 * that is not something an application can honestly do.
 */

type View = 'boost' | 'processes' | 'startup'

export function BoostPage() {
  const { toast, latest, monitoring, startMonitor, samples } = useStore()
  const [view, setView] = useState<View>('boost')

  const plan = useAsync(() => api.boost.plan(), [])
  const [selectedActions, setSelectedActions] = useState<Set<string>>(new Set())
  const [selectedPids, setSelectedPids] = useState<Set<number>>(new Set())
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<BoostResult | null>(null)
  const [beforeSample, setBeforeSample] = useState<{ cpu: number | null; gpu: number | null; mem: number } | null>(null)

  useEffect(() => {
    if (!plan.data) return
    const defaults = new Set(plan.data.actions.filter((action) => action.enabled && action.available).map((action) => action.id))
    setSelectedActions(defaults)
    setSelectedPids(new Set(plan.data.closableProcesses.filter((p) => p.category !== 'other').map((p) => p.pid)))
  }, [plan.data])

  async function apply() {
    if (!plan.data) return
    setApplying(true)
    setBeforeSample(
      latest
        ? { cpu: latest.cpu.usagePercent, gpu: latest.gpus[0]?.usagePercent ?? null, mem: latest.memory.usedBytes }
        : null
    )
    try {
      const outcome = await api.boost.apply({
        actionIds: [...selectedActions],
        closePids: selectedActions.has('close-apps') ? [...selectedPids] : [],
        powerPlanGuid: null
      })
      setResult(outcome)
      const failures = outcome.applied.filter((entry) => !entry.ok)
      toast({
        title: failures.length === 0 ? 'Boost applied' : `Applied with ${failures.length} problem(s)`,
        body: outcome.applied.map((entry) => entry.message).join(' '),
        tone: failures.length === 0 ? 'success' : 'warning'
      })
      if (!monitoring) void startMonitor()
      plan.reload()
    } catch (error) {
      toast({ title: 'Boost failed', body: errorMessage(error), tone: 'danger' })
    } finally {
      setApplying(false)
    }
  }

  async function revert() {
    if (!result?.revertToken) return
    try {
      const outcome = await api.boost.revert(result.revertToken)
      toast({ title: outcome.ok ? 'Reverted' : 'Could not revert', body: outcome.message, tone: outcome.ok ? 'success' : 'warning' })
      setResult(null)
      plan.reload()
    } catch (error) {
      toast({ title: 'Revert failed', body: errorMessage(error), tone: 'danger' })
    }
  }

  const reclaimable = plan.data
    ? plan.data.closableProcesses.filter((p) => selectedPids.has(p.pid)).reduce((sum, p) => sum + p.memoryBytes, 0)
    : 0

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Optimisation</div>
          <h1 className="page__title">Game Boost</h1>
          <p className="page__sub">
            Every change is listed, explained and opt-in. Windows-critical processes are never offered for closing, and the
            power plan change is remembered so it can be put back in one click.
          </p>
        </div>
        <Button loading={plan.loading} icon={<IconRefresh size={15} />} onClick={plan.reload}>
          Refresh plan
        </Button>
      </div>

      <Tabs
        value={view}
        onChange={setView}
        options={[
          { id: 'boost', label: 'Optimisation plan' },
          { id: 'processes', label: 'Background processes' },
          { id: 'startup', label: 'Startup impact' }
        ]}
      />

      {view === 'boost' && (
        <>
          {result && (
            <Panel
              title={
                <>
                  Game Boost active <Badge tone="ok">Applied</Badge>
                </>
              }
              accent
              actions={
                result.revertToken ? (
                  <Button onClick={() => void revert()}>Undo power plan change</Button>
                ) : undefined
              }
            >
              <div className="grid grid--4">
                <Stat
                  label="CPU now"
                  value={latest?.cpu.usagePercent === null || !latest ? DASH : Math.round(latest.cpu.usagePercent)}
                  unit={latest?.cpu.usagePercent === null || !latest ? undefined : '%'}
                  live
                  meta={beforeSample?.cpu !== null && beforeSample !== null ? `was ${Math.round(beforeSample.cpu ?? 0)}%` : 'no before reading'}
                />
                <Stat
                  label="GPU now"
                  value={latest?.gpus[0]?.usagePercent === null || !latest?.gpus[0] ? DASH : Math.round(latest.gpus[0].usagePercent ?? 0)}
                  unit={latest?.gpus[0]?.usagePercent === null || !latest?.gpus[0] ? undefined : '%'}
                  live
                  meta={beforeSample?.gpu !== null && beforeSample !== null ? `was ${Math.round(beforeSample.gpu ?? 0)}%` : 'no before reading'}
                />
                <Stat
                  label="Memory now"
                  value={latest ? gigabytes(latest.memory.usedBytes).replace(' GB', '') : DASH}
                  unit="GB"
                  live
                  meta={beforeSample ? `was ${gigabytes(beforeSample.mem)}` : 'no before reading'}
                />
                <Stat label="Frame rate" value={DASH} meta="Not measured by this app" tone="muted" />
              </div>

              <div className="stack stack--sm" style={{ marginTop: 16 }}>
                {result.applied.map((entry) => (
                  <div className="split small" key={entry.id}>
                    <Badge tone={entry.ok ? 'ok' : 'bad'}>{entry.ok ? 'Done' : 'Failed'}</Badge>
                    <span className="muted">{entry.message}</span>
                  </div>
                ))}
              </div>

              <Note tone="plain">
                The before and after figures above are simply the live readings from before and after you applied the plan.
                They are not a benchmark: desktop load varies second to second, so treat them as context, not proof.
              </Note>
            </Panel>
          )}

          <Panel
            title="Optimisation plan"
            icon={<IconBolt size={15} />}
            note="Nothing here runs until you press Apply."
            actions={
              <Button variant="primary" loading={applying} disabled={selectedActions.size === 0} onClick={() => void apply()}>
                Apply plan
              </Button>
            }
          >
            {plan.loading ? (
              <div className="stack stack--sm">
                {[0, 1, 2, 3].map((index) => (
                  <div key={index} className="skeleton" style={{ height: 62 }} />
                ))}
              </div>
            ) : plan.error ? (
              <Note tone="bad">{plan.error}</Note>
            ) : (
              <div className="stack stack--sm">
                {(plan.data?.actions ?? []).map((action) => (
                  <CheckRow
                    key={action.id}
                    checked={selectedActions.has(action.id) && action.available}
                    disabled={!action.available}
                    onChange={(next) => {
                      const set = new Set(selectedActions)
                      if (next) set.add(action.id)
                      else set.delete(action.id)
                      setSelectedActions(set)
                    }}
                    title={
                      <span className="split" style={{ gap: 8 }}>
                        {action.label}
                        {!action.available && <Badge tone="muted">Unavailable</Badge>}
                        {action.reversible && action.available && <Badge tone="info">Reversible</Badge>}
                        {action.requiresElevation && <Badge tone="warn">Needs admin</Badge>}
                      </span>
                    }
                    body={action.available ? action.detail : `${action.detail} ${action.unavailableReason ?? ''}`}
                  />
                ))}
              </div>
            )}
          </Panel>

          {selectedActions.has('close-apps') && (plan.data?.closableProcesses.length ?? 0) > 0 && (
            <Panel
              title="Apps to close"
              note={`${selectedPids.size} selected · ${bytes(reclaimable)} of working set currently held by them`}
            >
              <div className="stack stack--sm">
                {(plan.data?.closableProcesses ?? []).map((process) => (
                  <ProcessRow
                    key={process.pid}
                    process={process}
                    checked={selectedPids.has(process.pid)}
                    onChange={(next) => {
                      const set = new Set(selectedPids)
                      if (next) set.add(process.pid)
                      else set.delete(process.pid)
                      setSelectedPids(set)
                    }}
                  />
                ))}
              </div>
              <Note tone="plain">
                Closing an app releases the memory it was using — it does not "boost" memory beyond that, and the figure above
                is what those apps currently hold, not a promise of what a game will gain. Each app is asked to close normally
                first; only if it ignores that is it terminated.
              </Note>
            </Panel>
          )}

          {plan.data && plan.data.powerPlans.length > 0 && (
            <Panel title="Power plans" note={`Active: ${plan.data.powerPlans.find((p) => p.active)?.name ?? 'unknown'}`}>
              <div className="rows">
                {plan.data.powerPlans.map((powerPlan) => (
                  <div className="row" key={powerPlan.guid} style={{ padding: '11px 0', ['--row-cols' as string]: '1fr auto' }}>
                    <div className="row__main">
                      <div className="row__title">{powerPlan.name}</div>
                      <div className="row__sub mono">{powerPlan.guid}</div>
                    </div>
                    {powerPlan.active ? (
                      <Badge tone="ok">Active</Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          void api.power.setPlan(powerPlan.guid).then((outcome) => {
                            toast({ title: outcome.ok ? 'Power plan changed' : 'Could not change plan', body: outcome.message, tone: outcome.ok ? 'success' : 'warning' })
                            plan.reload()
                          })
                        }}
                      >
                        Activate
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </>
      )}

      {view === 'processes' && <ProcessesPanel />}
      {view === 'startup' && <StartupPanel />}
    </div>
  )
}

function ProcessRow({
  process,
  checked,
  onChange
}: {
  process: ProcessInfo
  checked: boolean
  onChange: (next: boolean) => void
}) {
  const categoryLabels: Record<ProcessInfo['category'], string> = {
    browser: 'Browser',
    launcher: 'Game launcher',
    updater: 'Updater',
    overlay: 'Overlay',
    recording: 'Recording',
    communication: 'Chat',
    system: 'System',
    other: 'Other'
  }
  return (
    <CheckRow
      checked={checked}
      onChange={onChange}
      disabled={process.protected}
      title={
        <span className="split" style={{ gap: 8 }}>
          {process.name}
          <Badge tone={process.category === 'system' ? 'muted' : 'info'}>{categoryLabels[process.category]}</Badge>
          {process.protected && <Badge tone="muted">Protected</Badge>}
        </span>
      }
      body={process.windowTitle ?? process.description ?? undefined}
      right={
        <span style={{ textAlign: 'right' }}>
          <span className="mono small" style={{ display: 'block' }}>
            {bytes(process.memoryBytes)}
          </span>
          <span className="small faint">{process.cpuPercent === null ? DASH : percent(process.cpuPercent, 1)} CPU</span>
        </span>
      }
    />
  )
}

function ProcessesPanel() {
  const processes = useAsync(() => api.processes.list(), [])
  const totals = (processes.data ?? []).reduce((sum, p) => sum + p.memoryBytes, 0)

  return (
    <Panel
      title="Background processes"
      note={`${processes.data?.length ?? 0} process group(s) · ${bytes(totals)} working set · CPU measured over a 600 ms window`}
      actions={
        <Button loading={processes.loading} icon={<IconRefresh size={14} />} onClick={processes.reload}>
          Refresh
        </Button>
      }
      flush
    >
      {processes.loading ? (
        <div style={{ padding: 20 }}>
          <div className="skeleton" style={{ height: 240 }} />
        </div>
      ) : processes.error ? (
        <div style={{ padding: 20 }}>
          <Note tone="bad">{processes.error}</Note>
        </div>
      ) : (
        <div className="rows">
          {(processes.data ?? []).slice(0, 40).map((process) => (
            <div className="row" key={process.pid} style={{ ['--row-cols' as string]: '1fr auto auto' }}>
              <div className="row__main">
                <div className="row__title">
                  {process.name}
                  {process.protected && (
                    <span className="small faint" style={{ marginLeft: 8 }}>
                      protected
                    </span>
                  )}
                </div>
                <div className="row__sub">{process.windowTitle ?? process.description ?? process.category}</div>
              </div>
              <span className="mono small">{percent(process.cpuPercent, 1)}</span>
              <span className="mono small" style={{ minWidth: 76, textAlign: 'right' }}>
                {bytes(process.memoryBytes)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

function StartupPanel() {
  const { toast } = useStore()
  const startup = useAsync(() => api.startup.list(), [])
  const [busy, setBusy] = useState<string | null>(null)

  async function toggle(item: StartupItem) {
    setBusy(item.name)
    try {
      const outcome = await api.startup.setEnabled({ name: item.name, location: item.location, enabled: !item.enabled })
      toast({ title: outcome.ok ? 'Startup entry updated' : 'Could not change entry', body: outcome.message, tone: outcome.ok ? 'success' : 'warning' })
      if (outcome.ok) startup.reload()
    } catch (error) {
      toast({ title: 'Change failed', body: errorMessage(error), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel
      title="Startup impact"
      note="Apps that launch with Windows. Impact is GameDriver Pro's own estimate — Windows does not publish its rating through an API."
      actions={
        <Button loading={startup.loading} icon={<IconRefresh size={14} />} onClick={startup.reload}>
          Refresh
        </Button>
      }
      flush
    >
      {startup.loading ? (
        <div style={{ padding: 20 }}>
          <div className="skeleton" style={{ height: 200 }} />
        </div>
      ) : (startup.data ?? []).length === 0 ? (
        <Empty title="No startup entries found" body="Nothing is registered to launch with Windows for this user." />
      ) : (
        <div className="rows">
          {(startup.data ?? []).map((item) => (
            <div className="row" key={`${item.name}|${item.location}`} style={{ ['--row-cols' as string]: '1fr auto auto' }}>
              <div className="row__main">
                <div className="row__title">{item.name}</div>
                <div className="row__sub mono">{item.command ?? item.location}</div>
              </div>
              <Badge tone={item.impact === 'high' ? 'bad' : item.impact === 'medium' ? 'warn' : item.impact === 'low' ? 'ok' : 'muted'}>
                {item.impact === 'unknown' ? 'Unknown' : `${item.impact} impact`}
              </Badge>
              <Button
                variant={item.enabled ? 'ghost' : 'default'}
                loading={busy === item.name}
                disabled={item.protected}
                onClick={() => void toggle(item)}
                title={item.protected ? 'Protected — GameDriver Pro will not disable this' : undefined}
              >
                {item.protected ? 'Protected' : item.enabled ? 'Disable' : 'Enable'}
              </Button>
            </div>
          ))}
        </div>
      )}
      <div style={{ padding: '0 20px 18px' }}>
        <Note tone="plain">
          Disabling a startup entry writes to the same <span className="mono">StartupApproved</span> key Task Manager uses, so
          the original entry is left intact and the change is fully reversible — here or in Task Manager. Entries that look
          like Windows components or device drivers are protected and cannot be disabled from this app.
        </Note>
      </div>
    </Panel>
  )
}
