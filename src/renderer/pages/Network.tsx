import { useState } from 'react'
import { api, errorMessage } from '../lib/api'
import { useStore } from '../lib/store'
import { Badge, Bar, Button, Empty, KeyValues, Note, Panel, Stat } from '../components/ui'
import { Chart } from '../components/Chart'
import { IconWifi } from '../components/Icons'
import { linkSpeed, number, percent, text, DASH } from '../lib/format'
import type { NetworkTestResult } from '../../shared/types'

/** Network check for online play: latency, jitter, packet loss, DNS. */

export function NetworkPage() {
  const { hardware, toast } = useStore()
  const [result, setResult] = useState<NetworkTestResult | null>(null)
  const [running, setRunning] = useState(false)

  const adapters = hardware?.network ?? []
  const active = adapters.filter((adapter) => adapter.status === 'Up' && !adapter.isVirtual)

  async function runTest() {
    setRunning(true)
    try {
      setResult(await api.network.test())
    } catch (error) {
      toast({ title: 'Network test failed', body: errorMessage(error), tone: 'danger' })
    } finally {
      setRunning(false)
    }
  }

  const ratingTone =
    result?.rating === 'excellent' ? 'ok' : result?.rating === 'good' ? 'ok' : result?.rating === 'fair' ? 'warn' : result?.rating === 'poor' ? 'bad' : 'muted'

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Diagnostics</div>
          <h1 className="page__title">Network check</h1>
          <p className="page__sub">
            Measures what matters for online play: round-trip latency, how much that latency varies, packet loss and DNS
            response time.
          </p>
        </div>
        <Button variant="primary" loading={running} icon={<IconWifi size={15} />} onClick={() => void runTest()}>
          {running ? 'Testing…' : 'Run network test'}
        </Button>
      </div>

      <div className="grid grid--4">
        <Stat
          label="Ping"
          value={result ? number(result.pingMs, 1) : DASH}
          unit={result?.pingMs !== null && result ? 'ms' : undefined}
          tone={result?.pingMs !== null && result?.pingMs !== undefined ? (result.pingMs < 30 ? 'ok' : result.pingMs < 80 ? 'warn' : 'bad') : 'muted'}
          meta={result ? `average of ${result.samples.length} replies` : 'not tested yet'}
        />
        <Stat
          label="Jitter"
          value={result ? number(result.jitterMs, 1) : DASH}
          unit={result?.jitterMs !== null && result ? 'ms' : undefined}
          tone={result?.jitterMs !== null && result?.jitterMs !== undefined ? (result.jitterMs < 8 ? 'ok' : result.jitterMs < 20 ? 'warn' : 'bad') : 'muted'}
          meta="variation between consecutive replies"
        />
        <Stat
          label="Packet loss"
          value={result ? number(result.packetLossPercent, 1) : DASH}
          unit={result?.packetLossPercent !== null && result ? '%' : undefined}
          tone={result?.packetLossPercent === 0 ? 'ok' : result?.packetLossPercent !== null && result?.packetLossPercent !== undefined ? 'bad' : 'muted'}
          meta="echoes sent that got no reply"
        />
        <Stat
          label="DNS lookup"
          value={result ? number(result.dnsMs, 0) : DASH}
          unit={result?.dnsMs !== null && result ? 'ms' : undefined}
          meta="time to resolve a game store hostname"
        />
      </div>

      {result && (
        <Panel
          title={
            <>
              Result <Badge tone={ratingTone}>{result.rating.toUpperCase()}</Badge>
            </>
          }
          note={`Target ${result.target}`}
        >
          <div className="stack">
            {result.samples.length > 1 && (
              <Chart
                capacity={result.samples.length}
                unit="ms"
                height={130}
                series={[{ label: 'Round trip', color: '#22d3ee', values: result.samples }]}
              />
            )}
            <Note tone="plain">{result.note}</Note>
          </div>
        </Panel>
      )}

      <Panel title="Adapters" icon={<IconWifi size={15} />} note={`${active.length} connected of ${adapters.length} detected`}>
        {adapters.length === 0 ? (
          <Empty title="No network adapters detected" />
        ) : (
          <div className="rows">
            {adapters.map((adapter) => (
              <div className="row" key={adapter.id} style={{ ['--row-cols' as string]: '1fr auto auto', padding: '12px 0' }}>
                <div className="row__main">
                  <div className="row__title">
                    {adapter.name}
                    {adapter.isVirtual && (
                      <span className="small faint" style={{ marginLeft: 8 }}>
                        virtual
                      </span>
                    )}
                  </div>
                  <div className="row__sub">
                    {text(adapter.description)} · {text(adapter.driverProvider)} {text(adapter.driverVersion)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="mono small">{linkSpeed(adapter.linkSpeedBps)}</div>
                  <div className="small faint">{text(adapter.ipv4)}</div>
                </div>
                <Badge tone={adapter.status === 'Up' ? 'ok' : 'muted'}>{text(adapter.status)}</Badge>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Why there is no speed test here">
        <div className="small muted stack">
          <p>
            Download and upload throughput can only be measured by transferring a large amount of data through a third-party
            speed-test server. That means sending your traffic — and your IP address — to somebody else's service, which is not
            something this app does behind your back.
          </p>
          <p>
            For online gaming, throughput is rarely the problem anyway. Latency, jitter and packet loss are what decide whether
            a match feels responsive, and those are all measured above. The negotiated link rate of each adapter is shown too,
            read straight from the driver.
          </p>
        </div>
      </Panel>
    </div>
  )
}
