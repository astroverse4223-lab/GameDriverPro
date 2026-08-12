import { useMemo } from 'react'
import { Badge, Note, Panel, Stat } from './ui'
import { IconPulse } from './Icons'
import { gigabytes, percent, temperature, DASH } from '../lib/format'
import type { HardwareSnapshot, MonitorSample } from '../../shared/types'

/**
 * Game Doctor — the app's diagnostic analyst.
 *
 * It runs entirely on this PC. It is a rule engine over measured telemetry, not a
 * cloud service, and it is labelled as such in the UI so nobody mistakes it for
 * something it isn't. Its two hard rules:
 *   - it never predicts a frame-rate gain, because it cannot measure frame rate;
 *   - with too little data it says so instead of producing a confident-sounding
 *     diagnosis from three samples.
 */

interface Finding {
  id: string
  title: string
  tone: 'info' | 'warn' | 'bad'
  observation: string
  reasoning: string
  recommendation: string
  benefit: string
}

const MIN_SAMPLES = 8

function average(values: (number | null)[]): number | null {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value))
  if (finite.length === 0) return null
  return finite.reduce((a, b) => a + b, 0) / finite.length
}

function peak(values: (number | null)[]): number | null {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value))
  return finite.length === 0 ? null : Math.max(...finite)
}

export function analyse(samples: MonitorSample[], hardware: HardwareSnapshot | null): { findings: Finding[]; verdict: string; gpuAvg: number | null; cpuAvg: number | null; vramRatio: number | null } {
  const cpuAvg = average(samples.map((s) => s.cpu.usagePercent))
  const gpuAvg = average(samples.map((s) => s.gpus[0]?.usagePercent ?? null))
  const gpuPeak = peak(samples.map((s) => s.gpus[0]?.usagePercent ?? null))
  const memAvg = average(samples.map((s) => s.memory.usagePercent))
  const tempPeak = peak(samples.map((s) => s.gpus[0]?.temperatureC ?? null))
  const vramUsed = average(samples.map((s) => s.gpus[0]?.vramUsedBytes ?? null))
  const vramTotal = samples[samples.length - 1]?.gpus[0]?.vramTotalBytes ?? hardware?.gpus[0]?.vramBytes ?? null
  const vramRatio = vramUsed !== null && vramTotal ? vramUsed / vramTotal : null

  const findings: Finding[] = []

  if (vramRatio !== null && vramRatio > 0.9) {
    findings.push({
      id: 'vram',
      title: 'Video memory is nearly full',
      tone: vramRatio > 0.96 ? 'bad' : 'warn',
      observation: `Video memory has averaged ${gigabytes(vramUsed)} of ${gigabytes(vramTotal)} (${Math.round(vramRatio * 100)}%).`,
      reasoning:
        'When a GPU runs out of dedicated memory it starts moving texture data across the PCIe bus to system RAM. That does not usually lower the average frame rate much, but it produces the uneven frame pacing people describe as stutter.',
      recommendation: 'Reduce texture quality by one level, or turn off the highest-resolution texture pack if the game ships one separately.',
      benefit: 'More consistent frame times. This does not necessarily raise the average frame rate.'
    })
  }

  if (gpuAvg !== null && cpuAvg !== null) {
    if (gpuAvg > 90 && cpuAvg < 70) {
      findings.push({
        id: 'gpu-bound',
        title: 'The GPU is the limiting component',
        tone: 'info',
        observation: `GPU utilisation averaged ${Math.round(gpuAvg)}% while the CPU averaged ${Math.round(cpuAvg)}%.`,
        reasoning:
          'A GPU pinned near 100% with CPU headroom to spare means the graphics card sets the pace. This is the normal, healthy state for a graphically demanding game — it means your CPU is not holding you back.',
        recommendation:
          'If you want more headroom, lower the settings that cost the GPU most: resolution scale, shadow quality, ray tracing and volumetric effects. Enabling the game’s upscaler (DLSS, FSR or XeSS) at Quality is usually the largest single gain.',
        benefit: 'Lower GPU load, which typically translates into higher and steadier frame rates.'
      })
    } else if (cpuAvg > 80 && gpuAvg < 70) {
      findings.push({
        id: 'cpu-bound',
        title: 'The CPU is the limiting component',
        tone: 'warn',
        observation: `CPU utilisation averaged ${Math.round(cpuAvg)}% while the GPU averaged ${Math.round(gpuAvg)}%.`,
        reasoning:
          'A busy CPU with an idle GPU means the game is waiting on simulation, draw-call submission or background work rather than on rendering. Graphics settings will barely move the needle in this state.',
        recommendation:
          'Close background applications (Boost can list them), and look for CPU-side settings in the game: crowd density, draw distance, physics detail and ray-traced effects that need CPU work to build.',
        benefit: 'Frees CPU time for the game. Graphics quality can often stay where it is.'
      })
    } else if (gpuAvg < 50 && cpuAvg < 50) {
      findings.push({
        id: 'idle',
        title: 'Neither component is under load',
        tone: 'info',
        observation: `GPU averaged ${Math.round(gpuAvg)}% and CPU averaged ${Math.round(cpuAvg)}%.`,
        reasoning:
          'These readings were taken while nothing demanding was running, so they describe your desktop rather than a game.',
        recommendation: 'Start a game, leave monitoring running, then come back — the analysis is only meaningful under load.',
        benefit: 'Accurate diagnosis instead of a guess.'
      })
    }
  }

  if (memAvg !== null && memAvg > 88) {
    findings.push({
      id: 'ram',
      title: 'System memory is under pressure',
      tone: 'warn',
      observation: `System memory usage averaged ${Math.round(memAvg)}% of ${gigabytes(hardware?.memory.totalBytes)}.`,
      reasoning:
        'With little free memory Windows starts paging to disk. During gameplay that shows up as hitches when new assets load, especially on a mechanical drive.',
      recommendation: 'Close background applications before playing. If this is routine at your usual settings, more RAM is the durable fix.',
      benefit: 'Fewer loading hitches. No effect on steady-state frame rate.'
    })
  }

  if (tempPeak !== null && tempPeak >= 83) {
    findings.push({
      id: 'gpu-temp',
      title: 'GPU is running hot',
      tone: tempPeak >= 88 ? 'bad' : 'warn',
      observation: `Peak GPU temperature was ${temperature(tempPeak)}.`,
      reasoning:
        'Modern GPUs reduce their own clock speeds as they approach their thermal limit. Sustained temperatures in the high 80s usually mean the card is throttling below the performance it is capable of.',
      recommendation: 'Improve case airflow, clear dust from the card’s heatsink, and check that intake fans are not obstructed.',
      benefit: 'Higher sustained clocks, and a card that lasts longer.'
    })
  }

  if (hardware && hardware.memory.modules.length === 1) {
    findings.push({
      id: 'single-channel',
      title: 'Memory is running in single channel',
      tone: 'warn',
      observation: `Only one memory module is installed (${gigabytes(hardware.memory.modules[0]?.capacityBytes ?? null)}).`,
      reasoning:
        'One module halves the available memory bandwidth. The effect is largest on integrated graphics and on CPU-limited games, where it shows up in the 1% low frame times rather than the average.',
      recommendation: 'Add a matched second module to form a dual-channel pair.',
      benefit: 'More memory bandwidth, which mainly improves minimum frame rates.'
    })
  }

  const verdict =
    samples.length < MIN_SAMPLES
      ? 'Not enough measured data yet.'
      : findings.length === 0
        ? 'No bottleneck stands out in the measured data.'
        : (findings[0]?.title ?? '')

  return { findings, verdict, gpuAvg, cpuAvg, vramRatio }
}

export function GameDoctor({
  samples,
  hardware,
  compact
}: {
  samples: MonitorSample[]
  hardware: HardwareSnapshot | null
  compact?: boolean
}) {
  const result = useMemo(() => analyse(samples, hardware), [samples, hardware])
  const enough = samples.length >= MIN_SAMPLES
  const gpuSample = samples[samples.length - 1]?.gpus[0] ?? null

  return (
    <Panel
      title={
        <>
          Game Doctor
          <Badge tone="brand">Local analysis</Badge>
        </>
      }
      icon={<IconPulse size={15} />}
      note="A rule-based read of your measured telemetry. Runs entirely on this PC — nothing is uploaded."
      accent
    >
      {!enough ? (
        <Note tone="plain">
          Game Doctor needs at least {MIN_SAMPLES} telemetry samples before it will say anything. It has {samples.length}.
          Start monitoring, run the game you care about for a minute, then come back — a diagnosis from three samples would be
          a guess dressed up as an answer.
        </Note>
      ) : (
        <div className="stack">
          {!compact && (
            <div className="grid grid--3">
              <Stat
                label="GPU average"
                value={result.gpuAvg === null ? DASH : Math.round(result.gpuAvg)}
                unit={result.gpuAvg === null ? undefined : '%'}
                tone={result.gpuAvg !== null && result.gpuAvg > 90 ? 'info' : 'muted'}
                meta={gpuSample?.source === 'nvidia-smi' ? 'from nvidia-smi' : gpuSample?.source === 'perf-counters' ? 'from Windows counters' : 'unavailable'}
              />
              <Stat
                label="CPU average"
                value={result.cpuAvg === null ? DASH : Math.round(result.cpuAvg)}
                unit={result.cpuAvg === null ? undefined : '%'}
                tone={result.cpuAvg !== null && result.cpuAvg > 80 ? 'warn' : 'muted'}
                meta="across all logical cores"
              />
              <Stat
                label="Video memory"
                value={result.vramRatio === null ? DASH : Math.round(result.vramRatio * 100)}
                unit={result.vramRatio === null ? undefined : '%'}
                tone={result.vramRatio !== null && result.vramRatio > 0.9 ? 'warn' : 'muted'}
                meta={
                  gpuSample?.vramUsedBytes && gpuSample.vramTotalBytes
                    ? `${gigabytes(gpuSample.vramUsedBytes)} of ${gigabytes(gpuSample.vramTotalBytes)}`
                    : 'not reported by this GPU'
                }
              />
            </div>
          )}

          <div style={{ fontSize: 15, fontWeight: 620 }}>{result.verdict}</div>

          {result.findings.length === 0 ? (
            <Note tone="plain">
              Nothing in the measured window points at a specific bottleneck. That is a real answer, not a fallback — if the
              game still runs poorly, capture telemetry while it is actually running and check the Crashes screen for driver
              faults.
            </Note>
          ) : (
            <div className="stack">
              {result.findings.map((finding) => (
                <div key={finding.id} className={`update${finding.tone === 'bad' ? ' update--critical' : finding.tone === 'warn' ? ' update--recommended' : ''}`}>
                  <div className="split">
                    <strong style={{ fontSize: 14 }}>{finding.title}</strong>
                    <Badge tone={finding.tone === 'bad' ? 'bad' : finding.tone === 'warn' ? 'warn' : 'info'}>
                      {finding.tone === 'bad' ? 'Address this' : finding.tone === 'warn' ? 'Worth changing' : 'Informational'}
                    </Badge>
                  </div>
                  <ul className="reasons">
                    <li>
                      <span>
                        <strong style={{ color: 'var(--text)' }}>Measured:</strong> {finding.observation}
                      </span>
                    </li>
                    <li>
                      <span>
                        <strong style={{ color: 'var(--text)' }}>Why it matters:</strong> {finding.reasoning}
                      </span>
                    </li>
                    <li>
                      <span>
                        <strong style={{ color: 'var(--text)' }}>Recommended change:</strong> {finding.recommendation}
                      </span>
                    </li>
                    <li>
                      <span>
                        <strong style={{ color: 'var(--text)' }}>Expected benefit:</strong> {finding.benefit}
                      </span>
                    </li>
                  </ul>
                </div>
              ))}
            </div>
          )}

          <Note tone="plain">
            Game Doctor never quotes an expected frame-rate figure. It cannot measure frame rate, and any number it invented
            would be fiction. It describes the direction of the change and why.
          </Note>
        </div>
      )}
    </Panel>
  )
}
