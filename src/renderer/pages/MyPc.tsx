import { useState } from 'react'
import { useStore } from '../lib/store'
import { Badge, Bar, Button, Empty, KeyValues, Note, Panel, Stat, Tabs } from '../components/ui'
import {
  IconBluetooth,
  IconCamera,
  IconChip,
  IconDrive,
  IconGamepad,
  IconMemory,
  IconMonitor,
  IconPc,
  IconPrinter,
  IconRefresh,
  IconSpeaker,
  IconUsb,
  IconWifi
} from '../components/Icons'
import { bytes, date, dateTime, duration, gigabytes, linkSpeed, megahertz, percent, temperature, text, DASH } from '../lib/format'
import type { DeviceStatus, GenericDevice } from '../../shared/types'

/** Full hardware inventory, one card per subsystem. */

type Section = 'overview' | 'storage' | 'devices' | 'displays'

function statusBadge(status: DeviceStatus) {
  if (status === 'ok') return <Badge tone="ok">OK</Badge>
  if (status === 'error') return <Badge tone="bad">Problem</Badge>
  if (status === 'disabled') return <Badge tone="muted">Disabled</Badge>
  if (status === 'warning') return <Badge tone="warn">Degraded</Badge>
  return <Badge tone="muted">Unknown</Badge>
}

function DeviceList({ devices, empty }: { devices: GenericDevice[]; empty: string }) {
  if (devices.length === 0) return <div className="small faint" style={{ padding: '6px 0' }}>{empty}</div>
  return (
    <div className="rows">
      {devices.map((device) => (
        <div className="row" key={device.id} style={{ padding: '11px 0', ['--row-cols' as string]: '1fr auto' }}>
          <div className="row__main">
            <div className="row__title">{device.name}</div>
            <div className="row__sub">
              {text(device.manufacturer)} · driver {text(device.driverVersion)} · {date(device.driverDate)}
            </div>
          </div>
          {statusBadge(device.status)}
        </div>
      ))}
    </div>
  )
}

export function MyPcPage() {
  const { hardware, hardwareLoading, hardwareError, refreshHardware } = useStore()
  const [section, setSection] = useState<Section>('overview')

  if (hardwareError && !hardware) {
    return (
      <div className="page">
        <Note tone="bad">
          <strong>Could not read this PC's hardware.</strong> {hardwareError}
          <div style={{ marginTop: 12 }}>
            <Button onClick={() => void refreshHardware()}>Try again</Button>
          </div>
        </Note>
      </div>
    )
  }

  if (!hardware) {
    return (
      <div className="page">
        <div className="page__head">
          <div>
            <div className="eyebrow">My PC</div>
            <h1 className="page__title">Reading hardware…</h1>
          </div>
        </div>
        <div className="grid grid--3">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className="skeleton" style={{ height: 130 }} />
          ))}
        </div>
      </div>
    )
  }

  const gpu = hardware.gpus.find((g) => g.vendor !== 'microsoft') ?? hardware.gpus[0] ?? null

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">My PC</div>
          <h1 className="page__title">{text(hardware.system.hostname)}</h1>
          <p className="page__sub">
            {hardware.system.osCaption} · build {hardware.system.osBuild} · {hardware.system.osArchitecture} ·{' '}
            {hardware.system.chassis} · up {duration(hardware.system.uptimeSeconds)}
          </p>
        </div>
        <Button loading={hardwareLoading} icon={<IconRefresh size={15} />} onClick={() => void refreshHardware()}>
          Re-detect
        </Button>
      </div>

      {hardware.warnings.length > 0 && (
        <Note tone="warn">
          <strong>{hardware.warnings.length} part(s) of this PC could not be fully read.</strong>
          <ul style={{ margin: '8px 0 0 16px' }}>
            {hardware.warnings.slice(0, 4).map((warning, index) => (
              <li key={index} style={{ fontSize: 12 }}>
                {warning}
              </li>
            ))}
          </ul>
          {!hardware.system.isElevated && (
            <div style={{ marginTop: 8 }}>
              Some of these queries need administrator rights. Run GameDriver Pro as administrator for full detail.
            </div>
          )}
        </Note>
      )}

      <Tabs
        value={section}
        onChange={setSection}
        options={[
          { id: 'overview', label: 'Overview' },
          { id: 'storage', label: `Storage (${hardware.storage.length})` },
          { id: 'devices', label: 'Devices' },
          { id: 'displays', label: `Displays (${hardware.displays.length})` }
        ]}
      />

      {section === 'overview' && (
        <>
          <div className="grid grid--pair">
            <Panel title="Graphics" icon={<IconMonitor size={15} />} note={`${hardware.gpus.length} adapter(s)`}>
              {hardware.gpus.length === 0 ? (
                <Empty title="No graphics adapter detected" />
              ) : (
                <div className="stack">
                  {hardware.gpus.map((adapter) => (
                    <div key={adapter.id} style={{ paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
                      <div className="split" style={{ marginBottom: 10 }}>
                        <strong style={{ fontSize: 14 }}>{adapter.name}</strong>
                        {statusBadge(adapter.status)}
                        {adapter.isPrimary && <Badge tone="info">Active display</Badge>}
                      </div>
                      <KeyValues
                        items={[
                          [
                            'Driver',
                            adapter.displayDriverVersion ? (
                              <>
                                <span className="mono">{adapter.displayDriverVersion}</span>{' '}
                                <span className="faint small">(Windows: {text(adapter.driverVersion)})</span>
                              </>
                            ) : (
                              <span className="mono">{text(adapter.driverVersion)}</span>
                            )
                          ],
                          ['Driver date', date(adapter.driverDate)],
                          ['Provider', text(adapter.driverProvider)],
                          [
                            'Video memory',
                            adapter.vramBytes ? (
                              <>
                                {gigabytes(adapter.vramBytes, 0)}{' '}
                                <span className="faint small">
                                  (from {adapter.vramSource === 'nvidia-smi' ? 'nvidia-smi' : adapter.vramSource === 'registry' ? 'the driver registry' : 'WMI'})
                                </span>
                              </>
                            ) : (
                              DASH
                            )
                          ],
                          ['Current mode', adapter.currentResolution ? `${adapter.currentResolution} @ ${adapter.refreshRateHz ?? '?'} Hz` : DASH]
                        ]}
                      />
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Processor" icon={<IconChip size={15} />}>
              <KeyValues
                items={[
                  ['Model', hardware.cpu.name],
                  ['Cores / threads', `${hardware.cpu.physicalCores ?? '?'} cores · ${hardware.cpu.logicalCores ?? '?'} threads`],
                  ['Base clock', megahertz(hardware.cpu.baseClockMhz)],
                  ['Max clock', megahertz(hardware.cpu.maxClockMhz)],
                  ['Socket', text(hardware.cpu.socket)],
                  ['L2 / L3 cache', `${bytes((hardware.cpu.l2CacheKb ?? 0) * 1024, 0)} / ${bytes((hardware.cpu.l3CacheKb ?? 0) * 1024, 0)}`],
                  [
                    'Virtualisation',
                    hardware.cpu.virtualizationEnabled === null
                      ? DASH
                      : hardware.cpu.virtualizationEnabled
                        ? 'Enabled in firmware'
                        : 'Not enabled in firmware'
                  ]
                ]}
              />
            </Panel>

            <Panel title="Memory" icon={<IconMemory size={15} />} note={`${hardware.memory.slotsUsed} of ${hardware.memory.slotsTotal ?? '?'} slots populated`}>
              <div className="split" style={{ marginBottom: 14 }}>
                <div style={{ flex: 1 }}>
                  <Bar
                    value={(hardware.memory.usedBytes / hardware.memory.totalBytes) * 100}
                    tone={hardware.memory.usedBytes / hardware.memory.totalBytes > 0.85 ? 'warn' : undefined}
                  />
                </div>
                <span className="mono small">
                  {gigabytes(hardware.memory.usedBytes)} / {gigabytes(hardware.memory.totalBytes, 0)}
                </span>
              </div>
              <div className="rows">
                {hardware.memory.modules.map((module, index) => (
                  <div className="row" key={index} style={{ padding: '9px 0', ['--row-cols' as string]: '1fr auto' }}>
                    <div className="row__main">
                      <div className="row__title">
                        {text(module.slot ?? module.bank)} · {gigabytes(module.capacityBytes, 0)}
                      </div>
                      <div className="row__sub">
                        {text(module.manufacturer)} {text(module.partNumber)}
                      </div>
                    </div>
                    <span className="mono small">
                      {module.formFactor ?? ''} {module.speedMhz ? `${module.speedMhz} MHz` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title="Motherboard & firmware" icon={<IconPc size={15} />}>
              <KeyValues
                items={[
                  ['Manufacturer', text(hardware.motherboard.manufacturer)],
                  ['Model', text(hardware.motherboard.product)],
                  ['System', `${text(hardware.system.manufacturer)} ${text(hardware.system.model)}`],
                  ['BIOS', `${text(hardware.motherboard.biosVendor)} ${text(hardware.motherboard.biosVersion)}`],
                  ['BIOS date', date(hardware.motherboard.biosReleaseDate)],
                  [
                    'Secure Boot',
                    hardware.motherboard.secureBoot === null
                      ? <span className="faint">Needs administrator rights to read</span>
                      : hardware.motherboard.secureBoot
                        ? 'Enabled'
                        : 'Disabled'
                  ],
                  ['Windows installed', date(hardware.system.installDate)],
                  ['Last boot', dateTime(hardware.system.lastBootTime)]
                ]}
              />
            </Panel>
          </div>

          {hardware.battery.present && (
            <Panel title="Battery" icon={<IconChip size={15} />}>
              <div className="grid grid--4">
                <Stat label="Charge" value={percent(hardware.battery.chargePercent)} meta={text(hardware.battery.status)} />
                <Stat
                  label="Health"
                  value={hardware.battery.healthPercent === null ? DASH : `${hardware.battery.healthPercent}%`}
                  meta="Full charge vs design capacity"
                  tone={hardware.battery.healthPercent !== null && hardware.battery.healthPercent < 70 ? 'warn' : 'muted'}
                />
                <Stat label="Design capacity" value={hardware.battery.designCapacityMwh ?? DASH} unit="mWh" />
                <Stat label="Full charge" value={hardware.battery.fullChargeCapacityMwh ?? DASH} unit="mWh" />
              </div>
            </Panel>
          )}
        </>
      )}

      {section === 'storage' && (
        <div className="grid grid--2">
          {hardware.storage.map((disk) => (
            <Panel
              key={disk.id}
              title={text(disk.friendlyName ?? disk.model)}
              icon={<IconDrive size={15} />}
              note={`${text(disk.mediaType)} · ${text(disk.busType)} · ${gigabytes(disk.sizeBytes, 0)}`}
              actions={
                disk.health.status && /healthy|ok/i.test(disk.health.status) ? (
                  <Badge tone="ok">{disk.health.status}</Badge>
                ) : disk.health.status ? (
                  <Badge tone="bad">{disk.health.status}</Badge>
                ) : (
                  <Badge tone="muted">No health data</Badge>
                )
              }
            >
              <div className="stack">
                {disk.volumes.length === 0 ? (
                  <div className="small faint">No mounted volumes on this disk.</div>
                ) : (
                  disk.volumes.map((volume) => {
                    const used = (volume.totalBytes ?? 0) - (volume.freeBytes ?? 0)
                    const ratio = volume.totalBytes ? used / volume.totalBytes : 0
                    return (
                      <div key={volume.letter ?? volume.label ?? Math.random()}>
                        <div className="split small" style={{ marginBottom: 6 }}>
                          <strong>
                            {volume.letter ? `${volume.letter}:` : ''} {volume.label ?? ''}
                          </strong>
                          <span className="right mono faint">
                            {gigabytes(volume.freeBytes, 0)} free of {gigabytes(volume.totalBytes, 0)}
                          </span>
                        </div>
                        <Bar value={ratio * 100} tone={ratio > 0.9 ? 'bad' : ratio > 0.8 ? 'warn' : undefined} />
                      </div>
                    )
                  })
                )}

                <KeyValues
                  items={[
                    ['Temperature', temperature(disk.health.temperatureC)],
                    ['Power-on hours', disk.health.powerOnHours === null ? DASH : disk.health.powerOnHours.toLocaleString()],
                    ['Wear', disk.health.wearPercent === null ? DASH : `${disk.health.wearPercent}%`],
                    ['Read errors', disk.health.readErrorsTotal === null ? DASH : disk.health.readErrorsTotal.toLocaleString()]
                  ]}
                />

                {!disk.health.available && (
                  <Note tone="plain">{disk.health.note}</Note>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}

      {section === 'devices' && (
        <div className="grid grid--2">
          <Panel title="Audio" icon={<IconSpeaker size={15} />} note={`${hardware.audio.length} device(s)`}>
            <DeviceList devices={hardware.audio} empty="No audio devices reported a driver." />
          </Panel>
          <Panel title="Network adapters" icon={<IconWifi size={15} />} note={`${hardware.network.length} adapter(s)`}>
            <div className="rows">
              {hardware.network.map((adapter) => (
                <div className="row" key={adapter.id} style={{ padding: '11px 0', ['--row-cols' as string]: '1fr auto' }}>
                  <div className="row__main">
                    <div className="row__title">
                      {adapter.name} {adapter.isVirtual && <span className="faint small">(virtual)</span>}
                    </div>
                    <div className="row__sub">
                      {text(adapter.description)} · {text(adapter.driverProvider)} {text(adapter.driverVersion)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="mono small">{linkSpeed(adapter.linkSpeedBps)}</div>
                    <div className="small faint">{adapter.status === 'Up' ? text(adapter.ipv4) : text(adapter.status)}</div>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Bluetooth" icon={<IconBluetooth size={15} />} note={`${hardware.bluetooth.length} device(s)`}>
            <DeviceList devices={hardware.bluetooth} empty="No Bluetooth radio detected on this PC." />
          </Panel>
          <Panel title="Controllers" icon={<IconGamepad size={15} />} note={`${hardware.controllers.length} device(s)`}>
            <DeviceList devices={hardware.controllers} empty="No game controllers are connected." />
          </Panel>
          <Panel title="USB" icon={<IconUsb size={15} />} note={`${hardware.usb.length} controller(s) / hub(s)`}>
            <DeviceList devices={hardware.usb} empty="No USB controllers reported." />
          </Panel>
          <Panel title="Cameras & printers" icon={<IconCamera size={15} />}>
            <div className="stack">
              <DeviceList devices={hardware.cameras} empty="No cameras detected." />
              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                <div className="eyebrow" style={{ marginBottom: 6 }}>
                  <IconPrinter size={12} /> Printers
                </div>
                <DeviceList devices={hardware.printers} empty="No printers detected." />
              </div>
            </div>
          </Panel>
        </div>
      )}

      {section === 'displays' && (
        <Panel title="Connected displays" icon={<IconMonitor size={15} />} note={`${hardware.displays.length} detected via EDID`}>
          {hardware.displays.length === 0 ? (
            <Empty title="No displays reported" body="Windows did not return monitor information through WMI on this PC." />
          ) : (
            <div className="grid grid--3">
              {hardware.displays.map((display) => (
                <div key={display.id} className="stat">
                  <div className="stat__label">{display.isPrimary ? 'Primary' : 'Secondary'}</div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{display.name}</div>
                  <div className="small faint">{text(display.manufacturer)}</div>
                  <KeyValues
                    items={[
                      ['Size', display.diagonalInches === null ? DASH : `${display.diagonalInches}"`],
                      ['Mode', display.resolution ? `${display.resolution} @ ${display.refreshRateHz ?? '?'} Hz` : <span className="faint">Reported per adapter only</span>]
                    ]}
                  />
                </div>
              ))}
            </div>
          )}
          <Note tone="plain">
            Windows reports the active display mode per graphics adapter rather than per monitor, so a resolution is only
            attributed to the primary display. Physical size comes from each monitor's EDID data.
          </Note>
        </Panel>
      )}
    </div>
  )
}
