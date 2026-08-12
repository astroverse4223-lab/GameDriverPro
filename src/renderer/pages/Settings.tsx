import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { Badge, Button, Note, Panel, Switch } from '../components/ui'
import { IconRefresh, IconShield, IconTerminal } from '../components/Icons'
import type { AppSettings } from '../../shared/types'

/** Settings, including a plain statement of what does and does not leave this PC. */

const THEMES: { id: AppSettings['theme']; label: string; swatch: [string, string] }[] = [
  { id: 'nebula', label: 'Nebula', swatch: ['#22d3ee', '#8b5cf6'] },
  { id: 'ember', label: 'Ember', swatch: ['#fb923c', '#f43f5e'] },
  { id: 'toxic', label: 'Toxic', swatch: ['#a3e635', '#22d3ee'] }
]

const INTERVALS = [500, 1000, 2000, 5000]

export function SettingsPage() {
  const { settings, saveSettings, hardware, monitoring, toast } = useStore()

  if (!settings) {
    return (
      <div className="page">
        <div className="skeleton" style={{ height: 300 }} />
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Configuration</div>
          <h1 className="page__title">Settings</h1>
          <p className="page__sub">Everything the app is allowed to do, in one place.</p>
        </div>
      </div>

      <div className="grid grid--2">
        <Panel title="Appearance">
          <div className="stack">
            <div>
              <div className="eyebrow" style={{ marginBottom: 10 }}>
                Accent theme
              </div>
              <div className="chips">
                {THEMES.map((theme) => (
                  <button
                    key={theme.id}
                    className="chip"
                    aria-pressed={settings.theme === theme.id}
                    onClick={() => void saveSettings({ theme: theme.id })}
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <span
                      style={{
                        width: 26,
                        height: 12,
                        borderRadius: 99,
                        background: `linear-gradient(90deg, ${theme.swatch[0]}, ${theme.swatch[1]})`
                      }}
                    />
                    {theme.label}
                  </button>
                ))}
              </div>
            </div>
            <Switch
              checked={settings.minimizeToTray}
              onChange={(next) => void saveSettings({ minimizeToTray: next })}
              label="Close to the system tray"
              description="Closing the window keeps GameDriver Pro running in the tray so monitoring continues. Exit from the tray menu always quits fully."
            />
            <Switch
              checked={settings.launchOnStartup}
              onChange={(next) => void saveSettings({ launchOnStartup: next })}
              label="Start with Windows"
              description="Registers GameDriver Pro as a login item, starting minimised to the tray. Nothing is written to your startup entries unless this is on."
            />
          </div>
        </Panel>

        <Panel title="Monitoring">
          <div className="stack">
            <div>
              <div className="eyebrow" style={{ marginBottom: 10 }}>
                Sample interval
              </div>
              <div className="chips">
                {INTERVALS.map((interval) => (
                  <button
                    key={interval}
                    className="chip"
                    aria-pressed={settings.monitorIntervalMs === interval}
                    onClick={() => void saveSettings({ monitorIntervalMs: interval })}
                  >
                    {interval < 1000 ? `${interval} ms` : `${interval / 1000} s`}
                  </button>
                ))}
              </div>
              <div className="small faint" style={{ marginTop: 8 }}>
                A longer interval means lower idle cost. One second is a good balance; the telemetry helper is a single
                long-lived process rather than one per sample, so the overhead is small either way.
              </div>
            </div>
            <div className="split small">
              <Badge tone={monitoring ? 'ok' : 'muted'}>{monitoring ? 'Monitoring active' : 'Monitoring paused'}</Badge>
              <span className="faint">Changing the interval restarts the monitor.</span>
            </div>
          </div>
        </Panel>

        <Panel title="Driver sources" icon={<IconShield size={15} />}>
          <div className="stack">
            <Switch
              checked={settings.allowVendorLookups}
              onChange={(next) => void saveSettings({ allowVendorLookups: next })}
              label="Query manufacturer driver-lookup services"
              description="Asks NVIDIA's own driver-lookup service which release is current for your exact GPU model and Windows version. Only the GPU model and OS identifiers are sent — nothing about you, your games or your files."
            />
            <Switch
              checked={settings.allowWindowsUpdateScan}
              onChange={(next) => void saveSettings({ allowWindowsUpdateScan: next })}
              label="Query Windows Update for drivers"
              description="Uses the same Windows Update Agent that Settings › Windows Update uses, to ask what Microsoft is offering for this hardware. Turning this off means driver scans rely on manufacturer lookups only."
            />
            <Note tone="plain">
              With both switched off, GameDriver Pro can still read your hardware and installed drivers, but it will honestly
              report that it has no basis for saying whether they are current.
            </Note>
          </div>
        </Panel>

        <Panel title="Notifications">
          <div className="stack">
            <Switch
              checked={settings.notifyDriverUpdates}
              onChange={(next) => void saveSettings({ notifyDriverUpdates: next })}
              label="Tell me about driver updates"
              description="A notification when a scan finds an update classed as critical or recommended. Optional updates never trigger one."
            />
            <Switch
              checked={settings.notifyDriverProblems}
              onChange={(next) => void saveSettings({ notifyDriverProblems: next })}
              label="Tell me about driver problems"
              description="A notification when Windows reports a device in an error state, or when the display driver crashes repeatedly."
            />
            <Switch
              checked={settings.gameDetection}
              onChange={(next) => void saveSettings({ gameDetection: next })}
              label="Detect installed games"
              description="Reads launcher metadata already on disk. Turn this off and the Games screen stays empty and no launcher folders are read."
            />
          </div>
        </Panel>
      </div>

      <Panel title="What leaves this PC" icon={<IconShield size={15} />} accent>
        <div className="stack">
          <div className="rows">
            {[
              ['Hardware identifiers, serial numbers, hardware IDs', 'Never sent anywhere.'],
              ['Crash dumps and Windows event logs', 'Read locally, never uploaded.'],
              ['Your games, save data and personal files', 'Never read beyond install folder names and sizes; never sent.'],
              ['GPU model and Windows version', settings.allowVendorLookups ? 'Sent to the manufacturer’s driver-lookup service to ask which release is current.' : 'Not sent — manufacturer lookups are off.'],
              ['Hardware IDs for driver matching', settings.allowWindowsUpdateScan ? 'Handled entirely by the Windows Update Agent, exactly as Windows Update itself does.' : 'Not sent — Windows Update scanning is off.'],
              ['Game artwork', 'Loaded from your launcher’s local cache. No CDN request is made.'],
              ['Telemetry or analytics about you', 'None. There is no analytics code in this app.']
            ].map(([subject, behaviour]) => (
              <div className="row" key={String(subject)} style={{ padding: '12px 0', ['--row-cols' as string]: 'minmax(0, 44%) 1fr' }}>
                <div className="row__title" style={{ whiteSpace: 'normal' }}>
                  {String(subject)}
                </div>
                <div className="small muted">{String(behaviour)}</div>
              </div>
            ))}
          </div>
          <Note tone="plain">
            The renderer process has no network access at all — outbound requests from the UI are blocked outright. The only
            network calls the app can make are the manufacturer driver lookups above, from the main process, restricted to an
            allow-list of official hosts over HTTPS.
          </Note>
        </div>
      </Panel>

      <Panel title="Advanced" icon={<IconTerminal size={15} />}>
        <div className="stack">
          <Switch
            checked={settings.developerMode}
            onChange={(next) => void saveSettings({ developerMode: next })}
            label="Developer mode"
            description="Adds a Developer screen showing Electron and Node versions, which hardware APIs answered, database engine, IPC counters and the live log tail."
          />
          <div className="split">
            <Button
              icon={<IconRefresh size={15} />}
              onClick={() => {
                void api.app.relaunch()
              }}
            >
              Restart GameDriver Pro
            </Button>
            <span className="small faint">
              {hardware?.system.isElevated
                ? 'Running with administrator rights — driver installs, restore points and driver export are available.'
                : 'Running without administrator rights. Driver installation, restore points and driver export need elevation.'}
            </span>
          </div>
          {!hardware?.system.isElevated && (
            <Note tone="warn">
              To enable those features, close GameDriver Pro, right-click it and choose “Run as administrator”. The app does not
              silently request elevation for itself.
            </Note>
          )}
        </div>
      </Panel>
    </div>
  )
}
