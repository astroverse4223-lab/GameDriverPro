import { api } from '../lib/api'
import { useAsync, useInterval } from '../lib/hooks'
import { Badge, Button, KeyValues, Note, Panel, Stat } from '../components/ui'
import { IconRefresh, IconTerminal } from '../components/Icons'
import { bytes, duration, text, DASH } from '../lib/format'
import { useStore } from '../lib/store'

/** Developer diagnostics: an honest inventory of what is working and what isn't. */

export function DeveloperPage() {
  const { samples, capabilities } = useStore()
  const diagnostics = useAsync(() => api.diagnostics.get(), [])

  useInterval(() => diagnostics.reload(), 10_000)

  const data = diagnostics.data

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Developer</div>
          <h1 className="page__title">Diagnostics</h1>
          <p className="page__sub">Refreshes every 10 seconds. Nothing here is sent anywhere.</p>
        </div>
        <Button loading={diagnostics.loading} icon={<IconRefresh size={15} />} onClick={diagnostics.reload}>
          Refresh
        </Button>
      </div>

      <div className="grid grid--4">
        <Stat label="Main process memory" value={bytes(data?.memoryBytes)} meta="resident set size" live />
        <Stat label="Uptime" value={duration(data?.uptimeSeconds)} meta="since the app started" />
        <Stat
          label="IPC calls"
          value={data?.ipc.callsHandled ?? DASH}
          meta={`${data?.ipc.errors ?? 0} error(s) across ${data?.ipc.channels ?? 0} channels`}
          tone={(data?.ipc.errors ?? 0) > 0 ? 'warn' : 'muted'}
          live
        />
        <Stat label="Telemetry buffer" value={samples.length} meta="samples held in the renderer" live />
      </div>

      <div className="grid grid--2">
        <Panel title="Versions" icon={<IconTerminal size={15} />}>
          <KeyValues
            items={[
              ['App', text(data?.versions.app)],
              ['Electron', text(data?.versions.electron)],
              ['Chromium', text(data?.versions.chrome)],
              ['Node', text(data?.versions.node)],
              ['V8', text(data?.versions.v8)],
              ['OS', text(data?.versions.os)]
            ]}
          />
        </Panel>

        <Panel title="Local store" note="Driver history, game profiles and settings.">
          <KeyValues
            items={[
              ['Engine', <span className="mono">{text(data?.database.engine)}</span>],
              ['Path', <span className="mono small">{text(data?.database.path)}</span>],
              ['History rows', data?.database.records ?? DASH],
              ['State', data?.database.ok ? <Badge tone="ok">Open</Badge> : <Badge tone="bad">Unavailable</Badge>]
            ]}
          />
          {data?.database.engine === 'json-fallback' && (
            <Note tone="plain">
              This Electron build does not expose <span className="mono">node:sqlite</span>, so the app is using its atomic JSON
              store instead. Same data, same behaviour — reported here rather than hidden.
            </Note>
          )}
        </Panel>

        <Panel title="Hardware APIs" note="What answered on this machine.">
          <div className="rows">
            {(data?.hardwareApis ?? []).map((entry) => (
              <div className="row" key={entry.name} style={{ padding: '11px 0', ['--row-cols' as string]: '1fr auto' }}>
                <div className="row__main">
                  <div className="row__title">{entry.name}</div>
                  <div className="row__sub">{entry.detail}</div>
                </div>
                <Badge tone={entry.ok ? 'ok' : 'muted'}>{entry.ok ? 'OK' : 'Unavailable'}</Badge>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Driver sources" note="State from the most recent scan.">
          {(data?.sources ?? []).length === 0 ? (
            <Note tone="plain">No scan has run in this session yet.</Note>
          ) : (
            <div className="rows">
              {(data?.sources ?? []).map((source) => (
                <div className="row" key={source.id} style={{ padding: '11px 0', ['--row-cols' as string]: '1fr auto auto' }}>
                  <div className="row__main">
                    <div className="row__title">{source.label}</div>
                    <div className="row__sub">{source.detail}</div>
                  </div>
                  <span className="mono small faint">{(source.durationMs / 1000).toFixed(1)}s</span>
                  <Badge tone={source.state === 'ok' ? 'ok' : source.state === 'error' ? 'bad' : 'muted'}>{source.state}</Badge>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Monitor capabilities">
        <div className="stack">
          <div className="chips">
            <span className="chip">CPU usage: {capabilities?.cpuUsage ? 'yes' : 'no'}</span>
            <span className="chip">CPU temp: {capabilities?.cpuTemperature ? 'yes' : 'no'}</span>
            <span className="chip">GPU telemetry: {capabilities?.gpuTelemetrySource ?? 'none'}</span>
            <span className="chip">Disk IO: {capabilities?.diskIo ? 'yes' : 'no'}</span>
            <span className="chip">Network IO: {capabilities?.networkIo ? 'yes' : 'no'}</span>
            <span className="chip">FPS: no</span>
          </div>
          {(capabilities?.notes ?? []).map((note, index) => (
            <Note key={index} tone="plain">
              {note}
            </Note>
          ))}
        </div>
      </Panel>

      <Panel title="Log tail" note="Newest last. The full log is written to the app's userData folder." flush>
        <pre
          className="mono"
          style={{
            margin: 0,
            padding: '16px 20px',
            maxHeight: 380,
            overflow: 'auto',
            fontSize: 11.5,
            lineHeight: 1.65,
            color: 'var(--text-dim)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {(data?.logTail ?? ['(no log entries yet)']).join('\n')}
        </pre>
      </Panel>
    </div>
  )
}
