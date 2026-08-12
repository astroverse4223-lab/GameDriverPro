import { useState } from 'react'
import { useAsync } from '../lib/hooks'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { Badge, Button, Empty, KeyValues, Note, Panel, Stat, Tabs } from '../components/ui'
import { IconAlert, IconRefresh, IconShield } from '../components/Icons'
import { bytes, dateTime, relative, text, DASH } from '../lib/format'
import type { CrashKind } from '../../shared/types'

/**
 * Crash analyser.
 *
 * Reads the Windows event log and any crash dumps on disk, groups repeats, and
 * states findings as correlations. Language is deliberately hedged — "possible
 * cause", "the module Windows named" — because an event log cannot prove a
 * diagnosis.
 */

const WINDOWS = [7, 30, 90] as const

const KIND_LABELS: Record<CrashKind, string> = {
  'display-driver-timeout': 'Display driver timeout',
  bugcheck: 'Stop error',
  'app-crash': 'Application crash',
  'driver-error': 'Driver / service error',
  'unexpected-shutdown': 'Unexpected shutdown',
  other: 'Other'
}

export function CrashesPage() {
  const { navigate } = useStore()
  const [days, setDays] = useState<number>(30)
  const [tab, setTab] = useState<'findings' | 'dumps' | 'events'>('findings')
  const analysis = useAsync(() => api.crashes.analyze(days), [days])

  const serious = (analysis.data?.groups ?? []).filter(
    (group) => group.kind === 'bugcheck' || group.kind === 'display-driver-timeout' || group.kind === 'unexpected-shutdown'
  )

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Diagnostics</div>
          <h1 className="page__title">Crash analysis</h1>
          <p className="page__sub">
            Built from the Windows System and Application event logs plus any crash dumps in <span className="mono">C:\Windows\Minidump</span>.
            Findings are correlations from Windows' own records, not confirmed diagnoses.
          </p>
        </div>
        <div className="split">
          <div className="chips">
            {WINDOWS.map((value) => (
              <button key={value} className="chip" aria-pressed={days === value} onClick={() => setDays(value)}>
                {value} days
              </button>
            ))}
          </div>
          <Button loading={analysis.loading} icon={<IconRefresh size={15} />} onClick={analysis.reload}>
            Re-analyse
          </Button>
        </div>
      </div>

      <div className="grid grid--4">
        <Stat
          label="Error events"
          value={analysis.data?.events.length ?? (analysis.loading ? '…' : DASH)}
          meta={`error and critical level, last ${days} days`}
          tone={(analysis.data?.events.length ?? 0) > 20 ? 'warn' : 'muted'}
        />
        <Stat
          label="Distinct problems"
          value={analysis.data?.groups.length ?? (analysis.loading ? '…' : DASH)}
          meta="after grouping repeats"
        />
        <Stat
          label="Serious faults"
          value={serious.reduce((sum, group) => sum + group.count, 0)}
          meta="stop errors, driver timeouts, dirty shutdowns"
          tone={serious.length > 0 ? 'bad' : 'ok'}
        />
        <Stat
          label="Crash dumps"
          value={analysis.data?.dumps.length ?? (analysis.loading ? '…' : DASH)}
          meta={analysis.data?.dumps.length ? 'stop code read from each header' : 'none found on disk'}
        />
      </div>

      {analysis.error && <Note tone="bad">{analysis.error}</Note>}

      {analysis.data && analysis.data.warnings.length > 0 && (
        <Note tone="warn">
          <strong>Some logs could not be read.</strong>
          <ul style={{ margin: '8px 0 0 16px' }}>
            {analysis.data.warnings.slice(0, 3).map((warning, index) => (
              <li key={index} style={{ fontSize: 12 }}>
                {warning}
              </li>
            ))}
          </ul>
        </Note>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { id: 'findings', label: `Findings (${analysis.data?.groups.length ?? 0})` },
          { id: 'dumps', label: `Crash dumps (${analysis.data?.dumps.length ?? 0})` },
          { id: 'events', label: `Raw events (${analysis.data?.events.length ?? 0})` }
        ]}
      />

      {tab === 'findings' && (
        <div className="stack">
          {analysis.loading ? (
            [0, 1, 2].map((index) => <div key={index} className="skeleton" style={{ height: 150 }} />)
          ) : (analysis.data?.groups.length ?? 0) === 0 ? (
            <Panel>
              <Empty
                icon={<IconShield size={20} />}
                title={`No error-level faults in the last ${days} days`}
                body="Windows recorded no stop errors, display driver timeouts or application crashes serious enough to appear here. That is a real result read from the event log, not a default."
              />
            </Panel>
          ) : (
            (analysis.data?.groups ?? []).map((group) => (
              <Panel
                key={group.key}
                title={
                  <>
                    {group.title}
                    <Badge tone={group.confidence === 'likely' ? 'warn' : 'muted'}>
                      {group.confidence === 'likely' ? 'Likely pattern' : 'Possible one-off'}
                    </Badge>
                  </>
                }
                icon={<IconAlert size={15} />}
                note={`${KIND_LABELS[group.kind]} · ${group.count} occurrence(s) · last ${relative(group.lastOccurrence)}`}
                actions={
                  group.kind === 'display-driver-timeout' ? (
                    <Button variant="ghost" onClick={() => navigate('drivers')}>
                      Open drivers
                    </Button>
                  ) : undefined
                }
              >
                <div className="stack">
                  <div className="grid grid--3">
                    <Stat label="Occurrences" value={group.count} meta={`in the last ${days} days`} tone={group.count > 3 ? 'bad' : 'warn'} />
                    <Stat label="First seen" value={dateTime(group.firstOccurrence)} meta="" />
                    <Stat label="Suspected module" value={<span className="mono">{text(group.suspected)}</span>} meta="named by Windows in the event" />
                  </div>

                  <div>
                    <div className="eyebrow" style={{ marginBottom: 8 }}>
                      Evidence
                    </div>
                    <ul className="reasons">
                      {group.evidence.map((line, index) => (
                        <li key={index}>{line}</li>
                      ))}
                    </ul>
                  </div>

                  <Note tone={group.count > 3 ? 'warn' : 'plain'}>
                    <strong>Recommended action.</strong> {group.recommendation}
                  </Note>
                </div>
              </Panel>
            ))
          )}
        </div>
      )}

      {tab === 'dumps' && (
        <Panel title="Crash dumps" note="Stop code is read directly from each dump's header.">
          {(analysis.data?.dumps.length ?? 0) === 0 ? (
            <Empty
              title="No crash dumps on disk"
              body="Windows writes a dump to C:\Windows\Minidump when it hits a stop error. An empty folder means no stop errors have been recorded — or that dump creation is disabled in System Properties."
            />
          ) : (
            <div className="stack">
              {(analysis.data?.dumps ?? []).map((dump) => (
                <div className="update" key={dump.path}>
                  <div className="update__head">
                    <div>
                      <strong>{dump.bugcheckName ?? dump.bugcheckCode ?? 'Stop code not readable'}</strong>
                      <div className="small faint mono">{dump.path}</div>
                    </div>
                    <Badge tone={dump.kind === 'kernel' ? 'brand' : 'info'}>{dump.kind === 'kernel' ? 'Kernel dump' : 'Minidump'}</Badge>
                  </div>
                  <KeyValues
                    items={[
                      ['Created', dateTime(dump.modifiedAt)],
                      ['Size', bytes(dump.sizeBytes)],
                      ['Stop code', <span className="mono">{text(dump.bugcheckCode)}</span>],
                      ['Meaning', text(dump.bugcheckName)]
                    ]}
                  />
                  <Note tone="plain">{dump.parseNote}</Note>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {tab === 'events' && (
        <Panel title="Raw events" note="Straight from the Windows event log, newest first." flush>
          {(analysis.data?.events.length ?? 0) === 0 ? (
            <Empty title="No matching events" />
          ) : (
            <div className="rows">
              {(analysis.data?.events ?? []).slice(0, 120).map((event) => (
                <div className="row" key={event.id} style={{ ['--row-cols' as string]: 'auto 1fr auto' }}>
                  <Badge tone={event.level === 'critical' ? 'bad' : event.level === 'error' ? 'warn' : 'muted'}>
                    {event.level}
                  </Badge>
                  <div className="row__main">
                    <div className="row__title">
                      {event.providerName} · event {event.eventId}
                      {event.module && <span className="mono faint small" style={{ marginLeft: 8 }}>{event.module}</span>}
                    </div>
                    <div className="row__sub">{event.message.split('\n')[0]}</div>
                  </div>
                  <span className="small faint">{dateTime(event.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
    </div>
  )
}
