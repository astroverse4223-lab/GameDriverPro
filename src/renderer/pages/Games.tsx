import { useMemo, useState } from 'react'
import { useStore } from '../lib/store'
import { api, errorMessage } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { Badge, Button, Empty, KeyValues, Modal, Note, Panel, Stat, Tabs } from '../components/ui'
import { GameDoctor } from '../components/GameDoctor'
import { IconExternal, IconFolder, IconGamepad, IconPlay, IconRefresh } from '../components/Icons'
import { artUrl, bytes, dateTime, initials, relative, text, DASH } from '../lib/format'
import type { GameEntry, GameLauncher } from '../../shared/types'

/**
 * Game library and per-game profiles.
 *
 * Detection reads launcher metadata that is already on disk — Steam app
 * manifests, Epic manifest items, GOG and Ubisoft registry entries, Xbox install
 * folders. No launcher credentials are asked for and no launcher API is called.
 */

const LAUNCHER_LABELS: Record<GameLauncher, string> = {
  steam: 'Steam',
  epic: 'Epic Games',
  gog: 'GOG',
  ea: 'EA',
  ubisoft: 'Ubisoft Connect',
  battlenet: 'Battle.net',
  xbox: 'Xbox',
  other: 'Other'
}

export function GamesPage() {
  const { hardware, samples, monitoring, startMonitor, toast } = useStore()
  const library = useAsync(() => api.games.list(false), [])
  const [launcher, setLauncher] = useState<GameLauncher | 'all'>('all')
  const [selected, setSelected] = useState<GameEntry | null>(null)
  const [busy, setBusy] = useState(false)

  const games = useMemo(() => {
    const all = library.data?.games ?? []
    return launcher === 'all' ? all : all.filter((game) => game.launcher === launcher)
  }, [library.data, launcher])

  const counts = useMemo(() => {
    const map = new Map<GameLauncher, number>()
    for (const game of library.data?.games ?? []) map.set(game.launcher, (map.get(game.launcher) ?? 0) + 1)
    return map
  }, [library.data])

  async function launch(game: GameEntry) {
    setBusy(true)
    try {
      const result = await api.games.launch(game.id)
      toast({ title: result.ok ? `Launching ${game.name}` : 'Could not launch', body: result.message, tone: result.ok ? 'success' : 'warning' })
      if (result.ok && !monitoring) void startMonitor()
    } catch (error) {
      toast({ title: 'Launch failed', body: errorMessage(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const totalSize = (library.data?.games ?? []).reduce((sum, game) => sum + (game.sizeBytes ?? 0), 0)

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Library</div>
          <h1 className="page__title">Games</h1>
          <p className="page__sub">
            {library.data
              ? `${library.data.games.length} game(s) detected across ${library.data.launchers.filter((l) => l.detected).length} launcher(s). Detected from local launcher metadata — no accounts, no cloud.`
              : 'Scanning launchers for installed games…'}
          </p>
        </div>
        <Button
          loading={library.loading}
          icon={<IconRefresh size={15} />}
          onClick={() => {
            void api.games.list(true).then(library.setData)
          }}
        >
          Rescan
        </Button>
      </div>

      {library.error && <Note tone="bad">{library.error}</Note>}

      <div className="grid grid--4">
        <Stat label="Games installed" value={library.data?.games.length ?? (library.loading ? '…' : DASH)} meta="across all detected launchers" />
        <Stat label="Measured size" value={totalSize > 0 ? bytes(totalSize, 0) : DASH} meta="only where the launcher reports it" />
        <Stat
          label="Most recent"
          value={library.data?.games.find((game) => game.lastPlayed)?.name ?? DASH}
          meta={
            library.data?.games.find((game) => game.lastPlayed)
              ? relative(library.data.games.find((game) => game.lastPlayed)?.lastPlayed ?? null)
              : 'No launcher reported a last-played time'
          }
        />
        <Stat
          label="GPU"
          value={hardware?.gpus[0] ? hardware.gpus[0].name.replace(/^NVIDIA |^AMD |^Intel\(R\) /, '') : DASH}
          meta={hardware?.gpus[0]?.displayDriverVersion ?? text(hardware?.gpus[0]?.driverVersion)}
        />
      </div>

      {library.data && library.data.games.length > 0 && (
        <Tabs
          value={launcher}
          onChange={setLauncher}
          options={[
            { id: 'all' as const, label: `All (${library.data.games.length})` },
            ...[...counts.entries()].map(([id, count]) => ({ id, label: `${LAUNCHER_LABELS[id]} (${count})` }))
          ]}
        />
      )}

      {library.loading ? (
        <div className="gamegrid">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="skeleton" style={{ aspectRatio: '2 / 3', borderRadius: 14 }} />
          ))}
        </div>
      ) : games.length === 0 ? (
        <Panel>
          <Empty
            icon={<IconGamepad size={20} />}
            title="No installed games detected"
            body={
              library.data && library.data.launchers.some((l) => l.detected)
                ? 'A launcher was found but it reports no installed games. If you keep games on another drive, make sure that library folder is registered in the launcher.'
                : 'No supported launcher was found on this PC. GameDriver Pro reads Steam, Epic, GOG, Ubisoft Connect and Xbox install data from disk — it never asks for launcher credentials.'
            }
          />
        </Panel>
      ) : (
        <div className="gamegrid">
          {games.map((game) => {
            const art = artUrl(game.heroImageUrl)
            return (
              <button key={game.id} className="gametile" onClick={() => setSelected(game)}>
                {art ? (
                  <img src={art} alt="" loading="lazy" />
                ) : (
                  <div className="gametile__fallback">{initials(game.name)}</div>
                )}
                <div className="gametile__veil" />
                <div className="gametile__info">
                  <div className="gametile__name">{game.name}</div>
                  <div className="gametile__meta">
                    {LAUNCHER_LABELS[game.launcher]}
                    {game.sizeBytes ? ` · ${bytes(game.sizeBytes, 0)}` : ''}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {library.data && (
        <Panel title="Launchers" note="What was found, and how.">
          <div className="rows">
            {library.data.launchers.map((entry) => (
              <div className="row" key={entry.launcher} style={{ padding: '11px 0', ['--row-cols' as string]: '1fr auto' }}>
                <div className="row__main">
                  <div className="row__title">{LAUNCHER_LABELS[entry.launcher]}</div>
                  <div className="row__sub">{entry.path ?? entry.note}</div>
                </div>
                <Badge tone={entry.detected ? 'ok' : 'muted'}>{entry.detected ? 'Detected' : 'Not found'}</Badge>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {library.data && library.data.warnings.length > 0 && (
        <Note tone="warn">
          <strong>{library.data.warnings.length} launcher folder(s) could not be fully read.</strong>
          <ul style={{ margin: '8px 0 0 16px' }}>
            {library.data.warnings.slice(0, 4).map((warning, index) => (
              <li key={index} style={{ fontSize: 12 }}>
                {warning}
              </li>
            ))}
          </ul>
        </Note>
      )}

      {selected && (
        <Modal
          title={selected.name}
          subtitle={`${LAUNCHER_LABELS[selected.launcher]}${selected.appId ? ` · app ${selected.appId}` : ''}`}
          onClose={() => setSelected(null)}
          actions={
            <>
              <Button icon={<IconFolder size={14} />} onClick={() => void api.games.openFolder(selected.id)}>
                Open folder
              </Button>
              {selected.storeUrl && (
                <Button icon={<IconExternal size={14} />} onClick={() => void api.app.openExternal(selected.storeUrl ?? '')}>
                  Store page
                </Button>
              )}
              <Button variant="primary" loading={busy} icon={<IconPlay size={14} />} onClick={() => void launch(selected)}>
                Play
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="grid grid--2">
              <Stat label="GPU" value={hardware?.gpus[0]?.name.replace(/^NVIDIA /, '') ?? DASH} meta={hardware?.gpus[0]?.displayDriverVersion ?? text(hardware?.gpus[0]?.driverVersion)} />
              <Stat
                label="Display mode"
                value={hardware?.gpus[0]?.currentResolution ?? DASH}
                meta={hardware?.gpus[0]?.refreshRateHz ? `${hardware.gpus[0].refreshRateHz} Hz` : 'refresh rate unknown'}
              />
            </div>

            <KeyValues
              items={[
                ['Install path', <span className="mono small">{selected.installPath}</span>],
                ['Size on disk', selected.sizeBytes ? bytes(selected.sizeBytes) : <span className="faint">Not reported by this launcher</span>],
                ['Last played', selected.lastPlayed ? dateTime(selected.lastPlayed) : <span className="faint">Not reported by this launcher</span>],
                ['Executable', selected.executable ? <span className="mono small">{selected.executable}</span> : <span className="faint">Not identified</span>],
                ['Launch method', selected.launchUrl ? `${LAUNCHER_LABELS[selected.launcher]} protocol` : selected.executable ? 'Direct executable' : <span className="faint">None available</span>]
              ]}
            />

            <GameDoctor samples={samples} hardware={hardware} compact />

            <Note tone="plain">
              In-game graphics settings are stored in each game's own configuration files in formats that differ per title and
              change between patches. GameDriver Pro does not parse or rewrite them, so it will not claim to know or change
              your current in-game settings — the recommendations above describe what to change and why.
            </Note>
          </div>
        </Modal>
      )}
    </div>
  )
}
