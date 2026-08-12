import { useState } from 'react'
import { api, errorMessage } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useStore } from '../lib/store'
import { Badge, Button, Empty, Modal, Note, Panel, Stat } from '../components/ui'
import { IconHistory, IconRefresh, IconTrash } from '../components/Icons'
import { dateTime, text, DASH } from '../lib/format'
import type { HistoryKind } from '../../shared/types'

/** Local record of every change this app made, and what happened. */

const KIND_LABELS: Record<HistoryKind, string> = {
  'driver-install': 'Driver install',
  'driver-rollback': 'Driver rollback',
  'restore-point': 'Restore point',
  'driver-backup': 'Driver backup',
  scan: 'Driver scan',
  boost: 'Game Boost'
}

export function HistoryPage() {
  const { toast } = useStore()
  const history = useAsync(() => api.history.list(300), [])
  const [confirmClear, setConfirmClear] = useState(false)
  const [filter, setFilter] = useState<HistoryKind | 'all'>('all')

  const records = (history.data ?? []).filter((record) => filter === 'all' || record.kind === filter)
  const installs = (history.data ?? []).filter((record) => record.kind === 'driver-install')
  const failures = (history.data ?? []).filter((record) => record.result === 'failed')

  async function clear() {
    try {
      await api.history.clear()
      setConfirmClear(false)
      history.reload()
      toast({ title: 'History cleared', tone: 'info' })
    } catch (error) {
      toast({ title: 'Could not clear history', body: errorMessage(error), tone: 'danger' })
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Audit trail</div>
          <h1 className="page__title">History</h1>
          <p className="page__sub">
            Every driver install, rollback, restore point, backup, scan and boost this app performed — with the result Windows
            reported. Stored locally on this PC only.
          </p>
        </div>
        <div className="split">
          <Button loading={history.loading} icon={<IconRefresh size={15} />} onClick={history.reload}>
            Refresh
          </Button>
          <Button
            variant="danger"
            icon={<IconTrash size={15} />}
            disabled={(history.data ?? []).length === 0}
            onClick={() => setConfirmClear(true)}
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="grid grid--4">
        <Stat label="Recorded events" value={(history.data ?? []).length} meta="most recent 300" />
        <Stat label="Driver installs" value={installs.length} meta={`${installs.filter((r) => r.result === 'success').length} succeeded`} />
        <Stat label="Failures" value={failures.length} meta="operations that did not complete" tone={failures.length > 0 ? 'warn' : 'ok'} />
        <Stat
          label="Last change"
          value={history.data && history.data.length > 0 ? KIND_LABELS[history.data[0]?.kind ?? 'scan'] : DASH}
          meta={history.data && history.data.length > 0 ? dateTime(history.data[0]?.timestamp ?? null) : 'nothing recorded yet'}
        />
      </div>

      <div className="chips">
        <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          All
        </button>
        {(Object.keys(KIND_LABELS) as HistoryKind[]).map((kind) => {
          const count = (history.data ?? []).filter((record) => record.kind === kind).length
          if (count === 0) return null
          return (
            <button key={kind} className="chip" aria-pressed={filter === kind} onClick={() => setFilter(kind)}>
              {KIND_LABELS[kind]} ({count})
            </button>
          )
        })}
      </div>

      <Panel flush>
        {history.loading ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" style={{ height: 220 }} />
          </div>
        ) : records.length === 0 ? (
          <Empty
            icon={<IconHistory size={20} />}
            title="Nothing recorded yet"
            body="Once you run a scan or install a driver, the full trail appears here — including the version it moved from and to, the source, and whether Windows reported success."
          />
        ) : (
          <div className="rows">
            {records.map((record) => (
              <div className="row" key={record.id} style={{ ['--row-cols' as string]: 'auto 1fr auto auto' }}>
                <Badge tone={record.kind === 'driver-install' ? 'brand' : record.kind === 'boost' ? 'info' : 'muted'}>
                  {KIND_LABELS[record.kind]}
                </Badge>
                <div className="row__main">
                  <div className="row__title">
                    {record.device ?? record.source ?? KIND_LABELS[record.kind]}
                    {record.fromVersion && record.toVersion && (
                      <span className="mono small" style={{ marginLeft: 10, color: 'var(--accent)' }}>
                        {record.fromVersion} → {record.toVersion}
                      </span>
                    )}
                  </div>
                  <div className="row__sub">{text(record.detail ?? record.source)}</div>
                </div>
                <span className="small faint">{dateTime(record.timestamp)}</span>
                <Badge
                  tone={
                    record.result === 'success' ? 'ok' : record.result === 'failed' ? 'bad' : record.result === 'pending' ? 'warn' : 'muted'
                  }
                >
                  {record.result}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Note tone="plain">
        This log is the only place a previous driver version is recorded. Windows keeps at most one backup driver package per
        device and does not expose its version, so if a rollback is ever needed this history is what tells you what you were
        running before.
      </Note>

      {confirmClear && (
        <Modal
          title="Clear driver history?"
          subtitle="This cannot be undone."
          onClose={() => setConfirmClear(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirmClear(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void clear()}>
                Clear history
              </Button>
            </>
          }
        >
          <Note tone="warn">
            Clearing the history deletes the record of which driver versions you previously ran. That record is what makes a
            manual rollback possible, so it is worth keeping unless the list has become noise.
          </Note>
        </Modal>
      )}
    </div>
  )
}
