import { getHardwareSnapshot } from './hardware'
import { getDriverInventory, driverAgeDays, primaryEntry } from './drivers'
import { lastScanResult } from './driverSources'
import { analyseCrashes } from './crashes'
import { restorePointStatus } from './driverActions'
import { log } from './logger'
import type { CheckState, HealthCheck, HealthReport } from '../../shared/types'

/**
 * The one-click PC check that produces the Gaming Health score.
 *
 * Two rules make the score meaningful rather than decorative:
 *  - a check that could not be evaluated counts as neither a pass nor a fail; it
 *    is excluded from the denominator and shown as "unknown";
 *  - every check carries problem / why it matters / evidence / action / risk, so
 *    nothing is a bare warning icon the user cannot act on.
 */

interface Weighted extends HealthCheck {
  weight: number
}

const STATE_SCORE: Record<CheckState, number> = { pass: 1, warn: 0.6, fail: 0, unknown: 0 }

export async function buildHealthReport(): Promise<HealthReport> {
  const [hardware, inventory] = await Promise.all([getHardwareSnapshot(false), getDriverInventory(false)])
  const checks: Weighted[] = []

  // --- GPU driver ----------------------------------------------------------
  const gpu = hardware.gpus.find((g) => g.vendor !== 'microsoft') ?? hardware.gpus[0] ?? null
  const scan = lastScanResult()
  const gpuUpdate = scan?.updates.find((u) => u.category === 'graphics' && u.availableVersion !== null)
  const gpuAge = driverAgeDays(gpu?.driverDate ?? null)

  if (!gpu) {
    checks.push({
      id: 'gpu-driver',
      label: 'Graphics driver',
      state: 'unknown',
      weight: 3,
      problem: 'No graphics adapter was detected.',
      why: 'Without a detected GPU the app cannot assess your most important gaming component.',
      evidence: ['Win32_VideoController returned no adapters.'],
      action: 'Open My PC and re-run detection.',
      risk: 'unknown',
      route: 'mypc'
    })
  } else if (gpuUpdate && (gpuUpdate.classification === 'critical' || gpuUpdate.classification === 'recommended')) {
    checks.push({
      id: 'gpu-driver',
      label: 'Graphics driver',
      state: gpuUpdate.classification === 'critical' ? 'fail' : 'warn',
      weight: 3,
      problem: `A newer driver is available for ${gpu.name}.`,
      why: 'GPU driver releases are where vendors add support and fixes for newly released games.',
      evidence: [
        `Installed: ${gpu.displayDriverVersion ?? gpu.driverVersion ?? 'unknown'}`,
        `Available: ${gpuUpdate.availableVersion}`,
        `Source: ${gpuUpdate.source.label}`,
        ...gpuUpdate.rationale.slice(0, 2)
      ],
      action: 'Open Drivers to review the update and its release notes.',
      risk: gpuUpdate.risk,
      route: 'drivers'
    })
  } else if (!scan) {
    checks.push({
      id: 'gpu-driver',
      label: 'Graphics driver',
      state: 'unknown',
      weight: 3,
      problem: 'This PC has not been scanned against official driver sources yet.',
      why: 'Without a scan the app has no basis for saying whether your GPU driver is current — and it will not guess.',
      evidence: [`Installed: ${gpu.displayDriverVersion ?? gpu.driverVersion ?? 'unknown'}`],
      action: 'Run Scan My PC to check official sources.',
      risk: 'unknown',
      route: 'drivers'
    })
  } else {
    checks.push({
      id: 'gpu-driver',
      label: 'Graphics driver',
      state: 'pass',
      weight: 3,
      problem: 'No newer graphics driver was found.',
      why: 'Your GPU driver matches the newest version the official sources report.',
      evidence: [
        `Installed: ${gpu.displayDriverVersion ?? gpu.driverVersion ?? 'unknown'}`,
        gpuAge !== null ? `Driver dated ${new Date(gpu.driverDate ?? '').toLocaleDateString()}.` : 'Driver date unavailable.',
        ...(scan?.sources.filter((s) => s.state === 'ok').map((s) => `Checked: ${s.label}`) ?? [])
      ],
      action: 'Nothing to do.',
      risk: 'low',
      route: 'drivers'
    })
  }

  // --- Devices Windows is complaining about --------------------------------
  const problemDevices = inventory.entries.filter((e) => e.status === 'error' && e.problemCode !== null)
  checks.push({
    id: 'device-problems',
    label: 'Device health',
    state: problemDevices.length === 0 ? 'pass' : problemDevices.length > 2 ? 'fail' : 'warn',
    weight: 3,
    problem:
      problemDevices.length === 0
        ? 'Windows reports no device problems.'
        : `Windows reports a problem with ${problemDevices.length} device(s).`,
    why: 'A device in an error state is not working, which can mean missing audio, no network, or a GPU running on a fallback driver.',
    evidence:
      problemDevices.length === 0
        ? [`${inventory.entries.length} driver packages checked, none in an error state.`]
        : problemDevices.slice(0, 4).map((d) => `${d.deviceName} — ${d.problemText ?? `problem code ${d.problemCode}`}`),
    action: problemDevices.length === 0 ? 'Nothing to do.' : 'Open Drivers and review the flagged devices.',
    risk: problemDevices.length === 0 ? 'low' : 'medium',
    route: 'drivers'
  })

  // --- Audio driver --------------------------------------------------------
  const audio = primaryEntry(inventory, 'audio')
  const audioAge = driverAgeDays(audio?.driverDate ?? null)
  checks.push({
    id: 'audio-driver',
    label: 'Audio driver',
    state: !audio ? 'unknown' : audio.status === 'error' ? 'fail' : audioAge !== null && audioAge > 1095 ? 'warn' : 'pass',
    weight: 1,
    problem: !audio
      ? 'No audio driver was identified.'
      : audio.status === 'error'
        ? `Windows reports a problem with ${audio.deviceName}.`
        : audioAge !== null && audioAge > 1095
          ? `${audio.deviceName} is running a driver from ${new Date(audio.driverDate ?? '').toLocaleDateString()}.`
          : `${audio.deviceName} is working normally.`,
    why: 'Audio drivers are a common source of in-game crackling, and a faulty audio stack can stall a game’s audio thread.',
    evidence: audio
      ? [`Provider: ${audio.driverProvider ?? 'unknown'}`, `Version: ${audio.driverVersion ?? 'unknown'}`]
      : ['No device in the audio class reported a driver.'],
    action:
      audio && (audio.status === 'error' || (audioAge !== null && audioAge > 1095))
        ? 'Open Drivers and check the manufacturer’s page for this device.'
        : 'Nothing to do.',
    risk: 'low',
    route: 'drivers'
  })

  // --- Driver signing ------------------------------------------------------
  checks.push({
    id: 'driver-signing',
    label: 'Driver signatures',
    state: inventory.unsignedDrivers === 0 ? 'pass' : 'warn',
    weight: 1,
    problem:
      inventory.unsignedDrivers === 0
        ? 'All detected drivers are digitally signed.'
        : `${inventory.unsignedDrivers} driver package(s) are not digitally signed.`,
    why: 'A signed driver is one Windows could verify came from its publisher unmodified. Unsigned kernel drivers are a stability and security risk.',
    evidence:
      inventory.unsignedDrivers === 0
        ? [`${inventory.entries.length} driver packages checked.`]
        : inventory.entries
            .filter((e) => e.isSigned === false)
            .slice(0, 4)
            .map((e) => `${e.deviceName} (${e.driverProvider ?? 'unknown publisher'})`),
    action: inventory.unsignedDrivers === 0 ? 'Nothing to do.' : 'Review these in Drivers — replace them with signed packages from the manufacturer if possible.',
    risk: inventory.unsignedDrivers === 0 ? 'low' : 'medium',
    route: 'drivers'
  })

  // --- Storage free space --------------------------------------------------
  const volumes = hardware.storage.flatMap((disk) => disk.volumes.filter((v) => v.totalBytes && v.freeBytes !== null))
  const tight = volumes.filter((v) => {
    const total = v.totalBytes ?? 0
    const free = v.freeBytes ?? 0
    return total > 0 && (free / total < 0.1 || free < 20 * 1024 ** 3)
  })
  checks.push({
    id: 'storage-space',
    label: 'Storage space',
    state: volumes.length === 0 ? 'unknown' : tight.length === 0 ? 'pass' : tight.length > 1 ? 'fail' : 'warn',
    weight: 2,
    problem:
      tight.length === 0
        ? 'All drives have healthy free space.'
        : `${tight.length} drive(s) are low on free space.`,
    why: 'Windows needs free space for the page file and shader caches. Under about 10% free, games stutter while installing shaders and updates fail.',
    evidence:
      volumes.length === 0
        ? ['No volumes reported usable size information.']
        : volumes.map((v) => {
            const total = v.totalBytes ?? 0
            const free = v.freeBytes ?? 0
            const pct = total > 0 ? Math.round((free / total) * 100) : 0
            return `${v.letter ?? '?'}: ${gib(free)} free of ${gib(total)} (${pct}%)`
          }),
    action: tight.length === 0 ? 'Nothing to do.' : 'Free space on the flagged drives, or move a large game to another drive.',
    risk: tight.length === 0 ? 'low' : 'medium',
    route: 'mypc'
  })

  // --- Storage health ------------------------------------------------------
  const unhealthy = hardware.storage.filter((d) => d.health.status !== null && !/healthy|ok/i.test(d.health.status))
  const anyHealthData = hardware.storage.some((d) => d.health.status !== null)
  checks.push({
    id: 'storage-health',
    label: 'Drive health',
    state: !anyHealthData ? 'unknown' : unhealthy.length > 0 ? 'fail' : 'pass',
    weight: 2,
    problem: !anyHealthData
      ? 'Windows did not report a health state for any drive.'
      : unhealthy.length > 0
        ? `${unhealthy.length} drive(s) are not reporting a healthy state.`
        : 'All drives report a healthy state to Windows.',
    why: 'A failing drive corrupts game installs and can take save data with it.',
    evidence: hardware.storage.map(
      (d) =>
        `${d.friendlyName ?? d.model ?? 'Disk'} — ${d.health.status ?? 'no health data'}${
          d.health.temperatureC !== null ? `, ${d.health.temperatureC}°C` : ''
        }${d.health.available ? '' : ' (SMART counters unavailable)'}`
    ),
    action: unhealthy.length > 0 ? 'Back up anything important on the flagged drive and check it with the manufacturer’s tool.' : 'Nothing to do.',
    risk: unhealthy.length > 0 ? 'high' : 'low',
    route: 'mypc'
  })

  // --- Memory --------------------------------------------------------------
  const totalGib = hardware.memory.totalBytes / 1024 ** 3
  const dualChannel = hardware.memory.modules.length >= 2
  checks.push({
    id: 'memory',
    label: 'System memory',
    state: totalGib < 8 ? 'fail' : totalGib < 16 || !dualChannel ? 'warn' : 'pass',
    weight: 2,
    problem:
      totalGib < 8
        ? `This PC has ${totalGib.toFixed(1)} GB of RAM.`
        : !dualChannel
          ? 'Memory appears to be running in single-channel configuration.'
          : totalGib < 16
            ? `This PC has ${totalGib.toFixed(1)} GB of RAM.`
            : `${totalGib.toFixed(1)} GB across ${hardware.memory.modules.length} module(s).`,
    why: 'Modern titles routinely commit 12–16 GB, and a single memory module halves available bandwidth, which shows up as lower minimum frame rates.',
    evidence: [
      `${hardware.memory.slotsUsed} of ${hardware.memory.slotsTotal ?? '?'} slots populated.`,
      ...hardware.memory.modules.map(
        (m) => `${m.slot ?? m.bank ?? 'Module'}: ${gib(m.capacityBytes ?? 0)} ${m.formFactor ?? ''} @ ${m.speedMhz ?? '?'} MHz`
      )
    ],
    action: totalGib < 16 || !dualChannel ? 'Consider adding a matched module to reach a dual-channel pair.' : 'Nothing to do.',
    risk: 'low',
    route: 'mypc'
  })

  // --- Crashes -------------------------------------------------------------
  let crashState: CheckState = 'unknown'
  let crashEvidence: string[] = ['Crash analysis has not run yet.']
  let crashProblem = 'Windows crash history has not been read yet.'
  let crashAction = 'Open Crashes to analyse the Windows event log.'
  try {
    const crashes = await analyseCrashes(30)
    const serious = crashes.groups.filter(
      (g) => g.kind === 'bugcheck' || g.kind === 'display-driver-timeout' || g.kind === 'unexpected-shutdown'
    )
    const totalSerious = serious.reduce((sum, g) => sum + g.count, 0)
    crashState = totalSerious === 0 ? 'pass' : totalSerious > 3 ? 'fail' : 'warn'
    crashProblem =
      totalSerious === 0
        ? 'No stop errors or display driver timeouts in the last 30 days.'
        : `${totalSerious} display driver timeout(s) or stop error(s) in the last 30 days.`
    crashEvidence =
      serious.length > 0
        ? serious.slice(0, 4).map((g) => `${g.title} — ${g.count}×, last ${new Date(g.lastOccurrence).toLocaleString()}`)
        : [`${crashes.events.length} error-level events reviewed across the System and Application logs.`]
    crashAction = totalSerious === 0 ? 'Nothing to do.' : 'Open Crashes for the full breakdown and suggested next step.'
  } catch {
    crashState = 'unknown'
  }
  checks.push({
    id: 'crashes',
    label: 'Crash history',
    state: crashState,
    weight: 3,
    problem: crashProblem,
    why: 'Repeated display driver timeouts and stop errors are the clearest signal that a driver, thermal or power problem is affecting gaming.',
    evidence: crashEvidence,
    action: crashAction,
    risk: crashState === 'fail' ? 'high' : crashState === 'warn' ? 'medium' : 'low',
    route: 'crashes'
  })

  // --- Network -------------------------------------------------------------
  const activeAdapters = hardware.network.filter((a) => a.status === 'Up' && !a.isVirtual)
  checks.push({
    id: 'network',
    label: 'Network',
    state: activeAdapters.length === 0 ? 'warn' : 'pass',
    weight: 1,
    problem:
      activeAdapters.length === 0
        ? 'No physical network adapter is connected.'
        : `${activeAdapters.length} network adapter(s) connected.`,
    why: 'Online play needs a stable connection; a wireless link with a low negotiated rate is a common cause of in-game lag.',
    evidence: activeAdapters.map(
      (a) => `${a.name} — ${a.linkSpeedBps ? `${Math.round(a.linkSpeedBps / 1_000_000)} Mb/s` : 'link rate unknown'}${a.ipv4 ? `, ${a.ipv4}` : ''}`
    ),
    action: activeAdapters.length === 0 ? 'Check your Ethernet cable or Wi-Fi connection.' : 'Run the network check for latency and jitter.',
    risk: 'low',
    route: 'network'
  })

  // --- Restore point ------------------------------------------------------
  const restore = await restorePointStatus()
  checks.push({
    id: 'restore-point',
    label: 'System protection',
    state: restore.enabled === true ? 'pass' : restore.enabled === false ? 'warn' : 'unknown',
    weight: 1,
    problem:
      restore.enabled === true
        ? 'Windows can create restore points on this PC.'
        : restore.enabled === false
          ? 'System protection is turned off, so Windows cannot create restore points.'
          : 'Whether system protection is enabled could not be determined.',
    why: 'A restore point taken before a driver change gives you a documented way back if the new driver misbehaves. It is not a guarantee of recovery.',
    evidence: [restore.note],
    action:
      restore.enabled === false
        ? 'Turn on system protection for your Windows drive in Windows Settings before installing drivers.'
        : 'Nothing to do.',
    risk: 'low',
    route: 'drivers'
  })

  // --- Score ---------------------------------------------------------------
  const evaluated = checks.filter((c) => c.state !== 'unknown')
  const weightSum = evaluated.reduce((sum, c) => sum + c.weight, 0)
  const scoreSum = evaluated.reduce((sum, c) => sum + c.weight * STATE_SCORE[c.state], 0)
  const score = weightSum > 0 ? Math.round((scoreSum / weightSum) * 100) : 0

  const failures = checks.filter((c) => c.state === 'fail').length
  const warnings = checks.filter((c) => c.state === 'warn').length
  const unknowns = checks.length - evaluated.length

  const summary =
    failures + warnings === 0
      ? unknowns > 0
        ? `Everything measured looks good. ${unknowns} check(s) could not be evaluated and are excluded from the score.`
        : 'Everything checked looks good.'
      : `${failures} issue(s) and ${warnings} recommendation(s) found${unknowns > 0 ? `, plus ${unknowns} check(s) that could not be evaluated` : ''}.`

  log.info('health', `Score ${score} from ${evaluated.length}/${checks.length} evaluated checks`)

  return {
    generatedAt: Date.now(),
    score,
    evaluatedChecks: evaluated.length,
    checks: checks.map(({ weight, ...check }) => check),
    summary
  }
}

function gib(bytes: number): string {
  if (bytes <= 0) return '0 GB'
  const gigabytes = bytes / 1024 ** 3
  return gigabytes >= 100 ? `${Math.round(gigabytes)} GB` : `${gigabytes.toFixed(1)} GB`
}
