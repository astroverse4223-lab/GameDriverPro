import { queryEmitted } from './powershell'
import { log, describeError } from './logger'
import type { NetworkTestResult } from '../../shared/types'

/**
 * Gaming network check: latency, jitter, packet loss and DNS response time.
 *
 * Deliberately scoped to what can be measured without shipping data anywhere:
 * ICMP echoes to the default gateway and to a public resolver, plus a DNS
 * lookup. Throughput ("download / upload speed") is not measured, because that
 * requires transferring data through a third-party speed-test server — so the
 * app reports the negotiated link rate and says plainly that throughput was not
 * tested, rather than printing an invented Mbps figure.
 */

const PING_SCRIPT = `
$out = [ordered]@{}
$target = $env:GDP_ARG_TARGET
$count = [int]$env:GDP_ARG_COUNT
if ($count -le 0) { $count = 12 }

$out.gateway = $null
try {
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1
  if ($route) { $out.gateway = [string]$route.NextHop }
} catch {}

$times = @()
$sent = 0
try {
  for ($i = 0; $i -lt $count; $i++) {
    $sent++
    $r = $null
    try { $r = Test-Connection -ComputerName $target -Count 1 -ErrorAction Stop } catch { $r = $null }
    if ($r) {
      $ms = $null
      if ($null -ne $r.ResponseTime) { $ms = [double]$r.ResponseTime }
      elseif ($null -ne $r.Latency) { $ms = [double]$r.Latency }
      if ($null -ne $ms) { $times += $ms }
    }
    Start-Sleep -Milliseconds 120
  }
} catch {}
$out.sent = $sent
$out.times = @($times)

$out.dnsMs = $null
try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $null = Resolve-DnsName -Name 'store.steampowered.com' -Type A -DnsOnly -ErrorAction Stop
  $out.dnsMs = [int]$sw.ElapsedMilliseconds
} catch {}

$out.gatewayPingMs = $null
if ($out.gateway) {
  try {
    $g = Test-Connection -ComputerName $out.gateway -Count 2 -ErrorAction Stop
    $vals = @($g | ForEach-Object { if ($null -ne $_.ResponseTime) { [double]$_.ResponseTime } elseif ($null -ne $_.Latency) { [double]$_.Latency } })
    if ($vals.Count -gt 0) { $out.gatewayPingMs = [math]::Round(($vals | Measure-Object -Average).Average, 1) }
  } catch {}
}

ConvertTo-Json -InputObject ([pscustomobject]$out) -Depth 4 -Compress
`

interface RawPing {
  gateway: string | null
  sent: number
  times: number[] | number | null
  dnsMs: number | null
  gatewayPingMs: number | null
}

/** The public resolver used for the latency probe, shown to the user verbatim. */
export const PING_TARGET = '1.1.1.1'

function arr(value: number[] | number | null | undefined): number[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** Mean absolute difference between consecutive round trips. */
export function computeJitter(samples: number[]): number | null {
  if (samples.length < 2) return null
  let total = 0
  for (let i = 1; i < samples.length; i++) {
    total += Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0))
  }
  return Math.round((total / (samples.length - 1)) * 10) / 10
}

export function rateConnection(
  ping: number | null,
  jitter: number | null,
  loss: number | null
): NetworkTestResult['rating'] {
  if (ping === null || loss === null) return 'unknown'
  if (loss > 5) return 'poor'
  if (ping < 30 && (jitter ?? 0) < 10 && loss === 0) return 'excellent'
  if (ping < 60 && (jitter ?? 0) < 20 && loss <= 1) return 'good'
  if (ping < 120 && loss <= 3) return 'fair'
  return 'poor'
}

export async function runNetworkTest(): Promise<NetworkTestResult> {
  const raw = await queryEmitted<RawPing>(PING_SCRIPT, {
    args: { TARGET: PING_TARGET, COUNT: '12' },
    timeoutMs: 60_000
  }).catch((error) => {
    log.warn('network', `Network test failed: ${describeError(error)}`)
    return null
  })

  if (!raw) {
    return {
      target: PING_TARGET,
      pingMs: null,
      jitterMs: null,
      packetLossPercent: null,
      samples: [],
      dnsMs: null,
      rating: 'unknown',
      note: 'The network test could not run. ICMP may be blocked by a firewall or VPN on this PC.'
    }
  }

  const samples = arr(raw.times)
  const sent = raw.sent > 0 ? raw.sent : samples.length
  const received = samples.length
  const loss = sent > 0 ? Math.round(((sent - received) / sent) * 1000) / 10 : null
  const average = received > 0 ? Math.round((samples.reduce((a, b) => a + b, 0) / received) * 10) / 10 : null
  const jitter = computeJitter(samples)

  const notes: string[] = []
  notes.push(`Latency measured with ${sent} ICMP echoes to ${PING_TARGET}.`)
  if (raw.gateway) {
    notes.push(
      raw.gatewayPingMs !== null
        ? `Your router (${raw.gateway}) answered in ${raw.gatewayPingMs} ms.`
        : `Your router (${raw.gateway}) did not answer ICMP, which many routers block by default.`
    )
  }
  if (received === 0) {
    notes.push('No replies were received — ICMP is likely blocked by a firewall or VPN, so this is not necessarily a connection problem.')
  }
  notes.push('Download and upload throughput are not measured: that would require sending data through a third-party speed-test server.')

  return {
    target: PING_TARGET,
    pingMs: average,
    jitterMs: jitter,
    packetLossPercent: loss,
    samples,
    dnsMs: raw.dnsMs,
    rating: rateConnection(average, jitter, loss),
    note: notes.join(' ')
  }
}
