import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../lib/store'
import { api, errorMessage } from '../lib/api'
import { Badge, Bar, Button, CheckRow, Empty, KeyValues, Modal, Note, Panel, Stat, Tabs } from '../components/ui'
import { CATEGORY_ICONS, IconChip, IconDownload, IconExternal, IconFolder, IconHistory, IconRefresh, IconSearch, IconShield } from '../components/Icons'
import { bytes, date, dateTime, relative, text, DASH } from '../lib/format'
import type {
  DriverCategory,
  DriverEntry,
  DriverUpdate,
  InstallProgress,
  RollbackInfo,
  UpdateClassification
} from '../../shared/types'

/**
 * Driver Manager: what is installed, what official sources say about it, and the
 * safe path to changing it.
 *
 * The screen is built around one rule from the spec that most driver utilities
 * break: not every available update should be recommended. Classification,
 * reasoning and source are always shown together, and an update the app cannot
 * verify is labelled Unknown rather than dressed up as urgent.
 */

const CATEGORY_ORDER: DriverCategory[] = [
  'graphics',
  'chipset',
  'audio',
  'network',
  'wifi',
  'bluetooth',
  'storage',
  'usb',
  'controller',
  'input',
  'display',
  'motherboard',
  'camera',
  'printer',
  'system',
  'other'
]

const CATEGORY_LABELS: Record<DriverCategory, string> = {
  graphics: 'Graphics',
  chipset: 'Chipset',
  audio: 'Audio',
  network: 'Network',
  wifi: 'Wi-Fi',
  bluetooth: 'Bluetooth',
  storage: 'Storage',
  usb: 'USB',
  motherboard: 'Motherboard',
  controller: 'Controllers',
  input: 'Input devices',
  display: 'Displays',
  camera: 'Cameras',
  printer: 'Printers',
  system: 'System devices',
  other: 'Other hardware'
}

const CLASSIFICATION_TONE: Record<UpdateClassification, 'bad' | 'warn' | 'info' | 'muted' | 'brand'> = {
  critical: 'bad',
  recommended: 'warn',
  optional: 'info',
  experimental: 'brand',
  unknown: 'muted'
}

const CLASSIFICATION_LABEL: Record<UpdateClassification, string> = {
  critical: 'Critical',
  recommended: 'Recommended',
  optional: 'Optional',
  experimental: 'Experimental',
  unknown: 'Unknown'
}

type View = 'updates' | 'installed' | 'safety'

export function DriversPage() {
  const { inventory, inventoryLoading, refreshInventory, scan, scanning, scanProgress, runScan, hardware, toast } = useStore()
  const [view, setView] = useState<View>('updates')
  const [category, setCategory] = useState<DriverCategory | 'all'>('all')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<DriverUpdate | null>(null)
  const [rollback, setRollback] = useState<RollbackInfo | null>(null)
  const [install, setInstall] = useState<{
    update: DriverUpdate
    restorePoint: boolean
    cleanInstall: boolean
    silent: boolean
  } | null>(null)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    const off = api.on.installProgress(setProgress)
    return off
  }, [])

  const updates = scan?.updates ?? []
  const grouped = useMemo(() => {
    const byClass: Record<UpdateClassification, DriverUpdate[]> = {
      critical: [],
      recommended: [],
      optional: [],
      experimental: [],
      unknown: []
    }
    for (const update of updates) byClass[update.classification].push(update)
    return byClass
  }, [updates])

  const installedFiltered = useMemo(() => {
    const entries = inventory?.entries ?? []
    const needle = query.trim().toLowerCase()
    return entries.filter((entry) => {
      if (category !== 'all' && entry.category !== category) return false
      if (!needle) return true
      return (
        entry.deviceName.toLowerCase().includes(needle) ||
        (entry.driverProvider ?? '').toLowerCase().includes(needle) ||
        (entry.driverVersion ?? '').includes(needle)
      )
    })
  }, [inventory, category, query])

  const problemEntries = (inventory?.entries ?? []).filter((entry) => entry.status === 'error')

  async function openRollback(entry: DriverEntry) {
    try {
      setRollback(await api.drivers.rollbackInfo(entry.id))
    } catch (error) {
      toast({ title: 'Could not read rollback state', body: errorMessage(error), tone: 'danger' })
    }
  }

  async function confirmInstall() {
    if (!install) return
    setInstalling(true)
    setProgress({ updateId: install.update.id, stage: 'preparing', percent: null, message: 'Starting' })
    try {
      const outcome = await api.drivers.install({
        updateId: install.update.id,
        createRestorePoint: install.restorePoint,
        confirmedDeviceName: install.update.deviceName,
        confirmedFromVersion: install.update.currentVersion,
        confirmedToVersion: install.update.availableVersion,
        cleanInstall: install.cleanInstall,
        silent: install.silent
      })
      toast({
        title: outcome.ok ? 'Driver installed' : 'Installation did not complete',
        body: outcome.message,
        tone: outcome.ok ? 'success' : 'danger'
      })
      if (outcome.ok) {
        setInstall(null)
        void refreshInventory(true)
      }
    } catch (error) {
      toast({ title: 'Installation failed', body: errorMessage(error), tone: 'danger' })
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Driver manager</div>
          <h1 className="page__title">Drivers</h1>
          <p className="page__sub">
            {inventory
              ? `${inventory.entries.length} driver packages installed across ${Object.keys(inventory.countsByCategory).length} categories.`
              : 'Reading the installed driver inventory…'}
            {scan ? ` Last checked against official sources ${relative(scan.finishedAt)}.` : ' Not yet checked against official sources.'}
          </p>
        </div>
        <div className="split">
          <Button loading={inventoryLoading} icon={<IconRefresh size={15} />} onClick={() => void refreshInventory(true)}>
            Re-read
          </Button>
          <Button variant="primary" loading={scanning} icon={<IconSearch size={15} />} onClick={() => void runScan()}>
            {scanning ? 'Scanning…' : 'Scan for updates'}
          </Button>
        </div>
      </div>

      {scanning && (
        <Panel title="Scanning" accent>
          <div className="stack">
            <div className="split small">
              <span>{scanProgress?.label ?? 'Working'}</span>
              <span className="right mono faint">
                step {scanProgress?.step ?? 0} of {scanProgress?.totalSteps ?? 5}
              </span>
            </div>
            <Bar value={scanProgress ? (scanProgress.step / Math.max(1, scanProgress.totalSteps)) * 100 : null} />
            <div className="small faint">
              Hardware is re-detected, the installed inventory re-read, then each enabled official source is queried in turn.
              A live Windows Update query typically takes 20–60 seconds.
            </div>
          </div>
        </Panel>
      )}

      <Tabs
        value={view}
        onChange={setView}
        options={[
          { id: 'updates', label: `Updates${updates.length > 0 ? ` (${updates.length})` : ''}` },
          { id: 'installed', label: `Installed (${inventory?.entries.length ?? 0})` },
          { id: 'safety', label: 'Safety & backup' }
        ]}
      />

      {/* ------------------------------------------------------------ updates */}
      {view === 'updates' && (
        <>
          {scan && (
            <Panel title="Sources checked" icon={<IconShield size={15} />} note="Only official manufacturer and Microsoft sources are used.">
              <div className="rows">
                {scan.sources.map((source) => (
                  <div className="row" key={source.id} style={{ padding: '11px 0', ['--row-cols' as string]: '1fr auto' }}>
                    <div className="row__main">
                      <div className="row__title">{source.label}</div>
                      <div className="row__sub">{source.detail}</div>
                    </div>
                    <div className="split">
                      {source.durationMs > 0 && <span className="mono small faint">{(source.durationMs / 1000).toFixed(1)}s</span>}
                      <Badge tone={source.state === 'ok' ? 'ok' : source.state === 'error' ? 'bad' : 'muted'}>
                        {source.state === 'ok' ? 'Answered' : source.state === 'error' ? 'Failed' : 'Skipped'}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {!scan ? (
            <Panel>
              <Empty
                icon={<IconSearch size={20} />}
                title="No scan has run yet"
                body="GameDriver Pro will not guess whether your drivers are current. Run a scan and it will ask NVIDIA's official lookup service and Windows Update directly, then tell you exactly which sources answered."
                action={
                  <Button variant="primary" loading={scanning} onClick={() => void runScan()}>
                    Scan for updates
                  </Button>
                }
              />
            </Panel>
          ) : updates.length === 0 ? (
            <Panel>
              <Empty
                icon={<IconShield size={20} />}
                title="Nothing to update"
                body={`Every source that answered reports your drivers are current. Checked ${scan.sources
                  .filter((s) => s.state === 'ok')
                  .map((s) => s.label)
                  .join(', ')}.`}
              />
            </Panel>
          ) : (
            <div className="stack">
              {(['critical', 'recommended', 'optional', 'experimental', 'unknown'] as UpdateClassification[]).map(
                (classification) =>
                  grouped[classification].length > 0 && (
                    <Panel
                      key={classification}
                      title={
                        <>
                          <Badge tone={CLASSIFICATION_TONE[classification]}>{CLASSIFICATION_LABEL[classification]}</Badge>
                          <span className="faint small" style={{ fontWeight: 400 }}>
                            {grouped[classification].length} item(s)
                          </span>
                        </>
                      }
                      note={noteFor(classification)}
                    >
                      <div className="stack">
                        {grouped[classification].map((update) => (
                          <UpdateCard
                            key={update.id}
                            update={update}
                            onDetails={() => setDetail(update)}
                            onInstall={() => setInstall({ update, restorePoint: true, cleanInstall: false, silent: true })}
                          />
                        ))}
                      </div>
                    </Panel>
                  )
              )}
            </div>
          )}
        </>
      )}

      {/* ---------------------------------------------------------- installed */}
      {view === 'installed' && (
        <>
          {problemEntries.length > 0 && (
            <Note tone="bad">
              <strong>Windows reports a problem with {problemEntries.length} device(s).</strong>
              <ul style={{ margin: '8px 0 0 16px' }}>
                {problemEntries.slice(0, 5).map((entry) => (
                  <li key={entry.id} style={{ fontSize: 12 }}>
                    {entry.deviceName} — {entry.problemText ?? `problem code ${entry.problemCode}`}
                  </li>
                ))}
              </ul>
            </Note>
          )}

          <Panel flush>
            <div style={{ padding: '18px 20px', display: 'grid', gap: 12 }}>
              <input
                className="chip"
                style={{ width: '100%', padding: '10px 14px', borderRadius: 10, background: 'var(--bg-inset)', fontSize: 13 }}
                placeholder="Search device, manufacturer or version…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="chips">
                <button className="chip" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>
                  All ({inventory?.entries.length ?? 0})
                </button>
                {CATEGORY_ORDER.filter((id) => (inventory?.countsByCategory[id] ?? 0) > 0).map((id) => (
                  <button key={id} className="chip" aria-pressed={category === id} onClick={() => setCategory(id)}>
                    {CATEGORY_LABELS[id]} ({inventory?.countsByCategory[id] ?? 0})
                  </button>
                ))}
              </div>
            </div>

            {installedFiltered.length === 0 ? (
              <Empty title="No drivers match" body="Try a different category or clear the search." />
            ) : (
              <div className="rows">
                {installedFiltered.map((entry) => {
                  const Icon = CATEGORY_ICONS[entry.category] ?? IconChip
                  return (
                    <div className="row" key={entry.id} style={{ ['--row-cols' as string]: 'auto 1fr auto auto' }}>
                      <span style={{ color: 'var(--text-faint)' }}>
                        <Icon size={16} />
                      </span>
                      <div className="row__main">
                        <div className="row__title">{entry.deviceName}</div>
                        <div className="row__sub">
                          {text(entry.driverProvider)} · {CATEGORY_LABELS[entry.category]} · {text(entry.infName)}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="mono small">{entry.displayVersion ?? text(entry.driverVersion)}</div>
                        <div className="small faint">{date(entry.driverDate)}</div>
                      </div>
                      <div className="split">
                        {entry.isSigned === false && <Badge tone="warn">Unsigned</Badge>}
                        {entry.status === 'error' ? (
                          <Badge tone="bad">Problem</Badge>
                        ) : entry.status === 'disabled' ? (
                          <Badge tone="muted">Disabled</Badge>
                        ) : (
                          <Badge tone="ok">OK</Badge>
                        )}
                        <Button variant="ghost" onClick={() => void openRollback(entry)}>
                          Rollback
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Panel>
        </>
      )}

      {view === 'safety' && <SafetyPanel />}

      {/* ------------------------------------------------------------ modals */}
      {detail && (
        <Modal
          title={detail.deviceName}
          subtitle={`${CATEGORY_LABELS[detail.category]} · ${detail.source.label}`}
          onClose={() => setDetail(null)}
          actions={
            <>
              {detail.source.url && (
                <Button
                  icon={<IconExternal size={14} />}
                  onClick={() => void api.app.openExternal(detail.source.url ?? '')}
                >
                  Open official source
                </Button>
              )}
              {detail.action !== 'manual' && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setInstall({ update: detail, restorePoint: true, cleanInstall: false, silent: true })
                    setDetail(null)
                  }}
                >
                  Update…
                </Button>
              )}
              <Button variant="ghost" onClick={() => setDetail(null)}>
                Close
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="split">
              <Badge tone={CLASSIFICATION_TONE[detail.classification]}>{CLASSIFICATION_LABEL[detail.classification]}</Badge>
              <Badge tone={detail.risk === 'low' ? 'ok' : detail.risk === 'high' ? 'bad' : detail.risk === 'medium' ? 'warn' : 'muted'}>
                Risk: {detail.risk}
              </Badge>
              {detail.verified ? <Badge tone="ok">Verified source</Badge> : <Badge tone="warn">Source unverified</Badge>}
            </div>

            <KeyValues
              items={[
                ['Installed', <span className="mono">{text(detail.currentVersion)}</span>],
                ['Available', <span className="mono">{text(detail.availableVersion)}</span>],
                ['Released', date(detail.releaseDate)],
                ['Download size', detail.sizeBytes ? bytes(detail.sizeBytes) : DASH],
                ['Source', detail.source.label],
                ['Verification', detail.verificationNote]
              ]}
            />

            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                Why this classification
              </div>
              <ul className="reasons">
                {detail.rationale.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </div>

            {detail.action === 'manual' && (
              <Note>
                GameDriver Pro will not install this package itself. {detail.source.kind === 'vendor-api'
                  ? 'The manufacturer’s installer needs to run interactively so you can choose options such as a clean installation.'
                  : 'No automatable official source exists for this device.'}{' '}
                Use the button below to open the manufacturer’s own download page.
              </Note>
            )}
          </div>
        </Modal>
      )}

      {install && (
        <Modal
          title="Confirm driver installation"
          subtitle={install.update.deviceName}
          onClose={() => !installing && setInstall(null)}
          actions={
            <>
              <Button variant="ghost" disabled={installing} onClick={() => setInstall(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={installing} onClick={() => void confirmInstall()}>
                Install now
              </Button>
            </>
          }
        >
          <div className="stack">
            <KeyValues
              items={[
                ['Device', install.update.deviceName],
                ['Currently installed', <span className="mono">{text(install.update.currentVersion)}</span>],
                ['Will install', <span className="mono">{text(install.update.availableVersion)}</span>],
                ['Source', install.update.source.label],
                ['Package', install.update.verificationNote]
              ]}
            />

            <CheckRow
              checked={install.restorePoint}
              onChange={(next) => setInstall({ ...install, restorePoint: next })}
              title="Create a Windows restore point first"
              body="A restore point can help revert some system changes if the new driver misbehaves. Windows does not guarantee recovery, and it limits how often restore points can be created."
            />

            {install.update.action === 'vendor-install' && install.update.download && (
              <>
                <CheckRow
                  checked={install.silent}
                  onChange={(next) => setInstall({ ...install, silent: next })}
                  title="Install unattended"
                  body={`Runs ${install.update.download.installerName} with the manufacturer's documented silent switches. Untick to watch the installer's own window and choose options yourself. Either way the screen may flicker and go black briefly while the display driver is replaced.`}
                />
                <CheckRow
                  checked={install.cleanInstall}
                  onChange={(next) => setInstall({ ...install, cleanInstall: next })}
                  title="Clean installation"
                  body="Removes the existing driver's settings and per-game profiles first, then installs fresh. This is the standard fix for a driver misbehaving after several upgrades — at the cost of losing your saved profiles and any overclock settings."
                />
              </>
            )}

            {!install.update.currentVersion && (
              <Note tone="warn">
                GameDriver Pro could not determine which version is currently installed for this device, so it cannot tell you
                what you would be moving away from.
              </Note>
            )}

            {progress && installing && (
              <div className="stack stack--sm">
                <div className="split small">
                  <span>{progress.message}</span>
                  <span className="right faint mono">
                    {progress.transferredBytes !== undefined
                      ? `${bytes(progress.transferredBytes)}${progress.totalBytes ? ` / ${bytes(progress.totalBytes)}` : ''}`
                      : progress.stage}
                  </span>
                </div>
                <Bar value={progress.percent} />
                {progress.percent === null && (
                  <div className="small faint">
                    This stage reports no percentage, so the bar shows activity rather than a made-up number.
                  </div>
                )}
              </div>
            )}

            {install.update.action === 'vendor-install' && install.update.download ? (
              <Note>
                GameDriver Pro downloads this package from{' '}
                <span className="mono">{new URL(install.update.download.url).hostname}</span> — the URL{' '}
                {install.update.source.label.replace(/^Official /, '')} itself returned — then checks its Authenticode
                signature names <strong>{install.update.download.expectedSigner}</strong> before running it. If that check
                fails the file is deleted and nothing is executed. No third-party driver repository is involved at any point.
              </Note>
            ) : (
              <Note>
                Nothing is installed until you press Install now. Windows Update performs the download, signature check and
                installation itself; GameDriver Pro only asks it to install this one package and records the result.
              </Note>
            )}
          </div>
        </Modal>
      )}

      {rollback && (
        <Modal
          title="Roll back driver"
          subtitle={rollback.deviceName}
          onClose={() => setRollback(null)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setRollback(null)}>
                Close
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  void api.drivers.openRollbackUi(rollback.deviceId).then((result) => {
                    toast({ title: result.ok ? 'Device Manager opened' : 'Could not open Device Manager', body: result.message, tone: result.ok ? 'info' : 'danger' })
                    setRollback(null)
                  })
                }}
              >
                Open in Device Manager
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="grid grid--2">
              <Stat label="Current" value={<span className="mono">{text(rollback.currentVersion)}</span>} />
              <Stat
                label="Previous (recorded by this app)"
                value={<span className="mono">{text(rollback.previousVersion)}</span>}
                meta={rollback.previousVersion ? undefined : 'No install by GameDriver Pro on record for this device'}
              />
            </div>
            <Note tone="warn">{rollback.reason}</Note>
          </div>
        </Modal>
      )}
    </div>
  )
}

function noteFor(classification: UpdateClassification): string {
  switch (classification) {
    case 'critical':
      return 'A device is in an error state, the driver is very old, or Microsoft flagged the update as important.'
    case 'recommended':
      return 'A meaningful improvement is likely — typically a new driver branch with support for recent games.'
    case 'optional':
      return 'Available, but no significant gaming benefit was detected. Keeping your current driver is reasonable.'
    case 'experimental':
      return 'Beta or non-WHQL releases. Useful for a specific title or fix, less validated than a stable release.'
    case 'unknown':
      return 'GameDriver Pro could not confirm whether a newer version exists, so it makes no claim. Check the official page.'
  }
}

function UpdateCard({
  update,
  onDetails,
  onInstall
}: {
  update: DriverUpdate
  onDetails: () => void
  onInstall: () => void
}) {
  const Icon = CATEGORY_ICONS[update.category] ?? IconChip
  const modifier =
    update.classification === 'critical' ? ' update--critical' : update.classification === 'recommended' ? ' update--recommended' : ''

  return (
    <div className={`update${modifier}`}>
      <div className="update__head">
        <div className="split" style={{ minWidth: 0 }}>
          <span style={{ color: 'var(--accent)' }}>
            <Icon size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 620 }}>{update.deviceName}</div>
            <div className="small faint">{update.source.label}</div>
          </div>
        </div>
        <div className="split">
          {update.releaseDate && <span className="small faint">Released {date(update.releaseDate)}</span>}
          {update.sizeBytes && <span className="small faint mono">{bytes(update.sizeBytes)}</span>}
          {update.verified && <Badge tone="ok">Verified</Badge>}
        </div>
      </div>

      <div className="update__versions">
        <div className="update__ver">
          <span>Installed</span>
          <strong>{text(update.currentVersion)}</strong>
        </div>
        {update.availableVersion && (
          <>
            <span className="update__arrow">→</span>
            <div className="update__ver">
              <span>Available</span>
              <strong style={{ color: 'var(--accent)' }}>{update.availableVersion}</strong>
            </div>
          </>
        )}
        {!update.availableVersion && (
          <>
            <span className="update__arrow">→</span>
            <div className="update__ver">
              <span>Available</span>
              <strong className="faint">Not determined</strong>
            </div>
          </>
        )}
      </div>

      <ul className="reasons">
        {update.rationale.slice(0, 3).map((reason, index) => (
          <li key={index}>{reason}</li>
        ))}
      </ul>

      <div className="split">
        <Button variant="ghost" onClick={onDetails}>
          View details
        </Button>
        {update.action !== 'manual' ? (
          <Button variant="primary" icon={<IconDownload size={14} />} onClick={onInstall}>
            {update.action === 'vendor-install' ? 'Download & install' : 'Update'}
          </Button>
        ) : (
          <Button
            icon={<IconExternal size={14} />}
            disabled={!update.source.url}
            onClick={() => update.source.url && void api.app.openExternal(update.source.url)}
          >
            Open official page
          </Button>
        )}
      </div>
    </div>
  )
}

function SafetyPanel() {
  const { toast, navigate } = useStore()
  const [restoreStatus, setRestoreStatus] = useState<{ enabled: boolean | null; note: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [backupResult, setBackupResult] = useState<string | null>(null)

  useEffect(() => {
    api.system
      .restorePointStatus()
      .then(setRestoreStatus)
      .catch(() => setRestoreStatus({ enabled: null, note: 'Could not query system protection.' }))
  }, [])

  async function createPoint() {
    setCreating(true)
    try {
      const result = await api.system.createRestorePoint(`GameDriver Pro — manual checkpoint ${new Date().toLocaleString()}`)
      toast({ title: result.ok ? 'Restore point created' : 'Restore point not created', body: result.message, tone: result.ok ? 'success' : 'warning' })
    } catch (error) {
      toast({ title: 'Restore point failed', body: errorMessage(error), tone: 'danger' })
    } finally {
      setCreating(false)
    }
  }

  async function backup() {
    setBackingUp(true)
    setBackupResult(null)
    try {
      const destination = await api.drivers.pickBackupFolder()
      if (!destination) {
        setBackingUp(false)
        return
      }
      const result = await api.drivers.backup(destination)
      setBackupResult(result.message)
      toast({
        title: result.ok ? `Backed up ${result.driverCount} driver package(s)` : 'Backup did not complete',
        body: result.message,
        tone: result.ok ? 'success' : 'warning'
      })
    } catch (error) {
      toast({ title: 'Backup failed', body: errorMessage(error), tone: 'danger' })
    } finally {
      setBackingUp(false)
    }
  }

  return (
    <div className="grid grid--2">
      <Panel title="Windows restore point" icon={<IconShield size={15} />} note="Taken automatically before an install, or manually here.">
        <div className="stack">
          {restoreStatus ? (
            <Note tone={restoreStatus.enabled === true ? 'plain' : 'warn'}>{restoreStatus.note}</Note>
          ) : (
            <div className="skeleton" style={{ height: 44 }} />
          )}
          <Button variant="primary" loading={creating} onClick={() => void createPoint()}>
            Create restore point
          </Button>
          <div className="small faint">
            A Windows restore point can help revert certain system changes if something goes wrong. It is not a guarantee of
            recovery, it does not back up your personal files, and Windows limits how often one can be created — by default
            once every 24 hours.
          </div>
        </div>
      </Panel>

      <Panel title="Driver backup" icon={<IconFolder size={15} />} note="Exports installed third-party driver packages.">
        <div className="stack">
          <Button loading={backingUp} icon={<IconFolder size={15} />} onClick={() => void backup()}>
            Choose folder and back up
          </Button>
          {backupResult && <Note tone="plain">{backupResult}</Note>}
          <div className="small faint">
            This uses Windows' own <span className="mono">pnputil /export-driver</span> to copy every third-party driver
            package out of the driver store. Windows' own in-box drivers are not exported — Windows can always reinstall
            those itself. Administrator rights are required.
          </div>
        </div>
      </Panel>

      <Panel title="Clean vs normal installation" icon={<IconChip size={15} />}>
        <div className="stack small muted">
          <p>
            <strong style={{ color: 'var(--text)' }}>Normal installation</strong> keeps your existing driver settings and
            profiles, and replaces the driver files in place. It is faster and almost always what you want.
          </p>
          <p>
            <strong style={{ color: 'var(--text)' }}>Clean installation</strong> removes the existing driver's settings and
            profiles first, then installs fresh. It is the standard fix for a driver that is behaving strangely after several
            upgrades, at the cost of losing per-game profiles and overclock settings.
          </p>
          <p>
            This choice lives inside the manufacturer's own installer — NVIDIA, AMD and Intel each expose it as a checkbox.
            GameDriver Pro does not manually delete driver files or registry keys to imitate it.
          </p>
        </div>
      </Panel>

      <Panel title="Driver history" icon={<IconHistory size={15} />}>
        <div className="stack">
          <div className="small muted">
            Every install, rollback, restore point and backup this app performs is recorded locally with its result, so you
            can see exactly what changed and when.
          </div>
          <Button onClick={() => navigate('history')}>Open history</Button>
        </div>
      </Panel>
    </div>
  )
}
