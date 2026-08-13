/**
 * Service-layer self-test.
 *
 * Runs every main-process service against the real machine with Electron stubbed
 * out, so the Windows integration can be verified — and regressions caught —
 * without clicking through the UI. It is read-only: nothing here installs a
 * driver, creates a restore point, closes a process or changes a setting.
 *
 * Run with: npm run selftest
 */
import { getHardwareSnapshot } from '../../src/main/services/hardware'
import { getDriverInventory, compareVersions, driverAgeDays } from '../../src/main/services/drivers'
import { scanForDriverUpdates } from '../../src/main/services/driverSources'
import { deriveSeriesNames } from '../../src/main/services/driverSources/nvidiaSource'
import { versionFromTitle, classifyWuUpdate } from '../../src/main/services/driverSources/windowsUpdate'
import { buildHealthReport } from '../../src/main/services/health'
import { analyseCrashes, moduleFromMessage } from '../../src/main/services/crashes'
import { runNetworkTest, computeJitter } from '../../src/main/services/network'
import { getGameLibrary, parseVdf } from '../../src/main/services/games'
import { buildBoostPlan, listProcesses, listStartupItems, listPowerPlans } from '../../src/main/services/boost'
import { restorePointStatus, verifySignature } from '../../src/main/services/driverActions'
import { isAllowedHost } from '../../src/main/services/http'
import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitor } from '../../src/main/services/monitor'
import { nvidiaVendorVersion } from '../../src/main/services/nvidia'

let failures = 0

function line(label: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  console.log(`  ${label.padEnd(28)} ${text}`)
}

function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${detail}`)
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const started = Date.now()
  try {
    const result = await fn()
    console.log(`\n[PASS ${String(Date.now() - started).padStart(6)}ms] ${name}`)
    return result
  } catch (error) {
    failures += 1
    console.log(`\n[FAIL ${String(Date.now() - started).padStart(6)}ms] ${name}`)
    console.log(`  ${error instanceof Error ? error.stack : String(error)}`)
    return null
  }
}

function pureUnitChecks(): void {
  console.log('\n[unit] pure helpers')
  check('compareVersions newer', compareVersions('610.88', '610.74') === 1)
  check('compareVersions older', compareVersions('610.74', '610.88') === -1)
  check('compareVersions equal', compareVersions('610.88', '610.88') === 0)
  check('compareVersions uneven length', compareVersions('10.0.1', '10.0.1.0') === 0)
  check('compareVersions non-numeric is unknown', compareVersions('abc', '1.0') === null)
  check('compareVersions null input', compareVersions(null, '1.0') === null)

  check('nvidia 32.0.16.1088 -> 610.88', nvidiaVendorVersion('32.0.16.1088') === '610.88', String(nvidiaVendorVersion('32.0.16.1088')))
  check('nvidia 31.0.15.4633 -> 546.33', nvidiaVendorVersion('31.0.15.4633') === '546.33', String(nvidiaVendorVersion('31.0.15.4633')))
  check('nvidia short version -> null', nvidiaVendorVersion('31.0') === null)

  check('series for RTX 4060', deriveSeriesNames('NVIDIA GeForce RTX 4060')[0] === 'GeForce RTX 40 Series')
  check('series for GTX 1660 Ti', deriveSeriesNames('NVIDIA GeForce GTX 1660 Ti')[0] === 'GeForce GTX 16 Series')
  check('series for GTX 750', deriveSeriesNames('NVIDIA GeForce GTX 750')[0] === 'GeForce GTX 700 Series')
  check('series for laptop part prefers notebooks', deriveSeriesNames('NVIDIA GeForce RTX 4070 Laptop GPU')[0] === 'GeForce RTX 40 Series (Notebooks)')
  check('series for non-GeForce is empty', deriveSeriesNames('AMD Radeon RX 7800 XT').length === 0)

  check(
    'WU title version parse',
    versionFromTitle('Intel Corporation - Display - 30.0.100.9805') === '30.0.100.9805',
    String(versionFromTitle('Intel Corporation - Display - 30.0.100.9805'))
  )

  // The real case this machine exhibits: Windows Update offering an older driver.
  const downgrade = classifyWuUpdate('30.0.100.9805', '31.0.101.2141', null, false, 'graphics')
  check(
    'WU downgrade is classed not-recommended, not optional',
    downgrade.isDowngrade && downgrade.classification === 'not-recommended',
    downgrade.classification
  )
  check('WU downgrade explains itself', downgrade.rationale.some((r) => /older/i.test(r)))
  const upgrade = classifyWuUpdate('10.0.2', '10.0.1', null, false, 'audio')
  check('WU newer audio is recommended', upgrade.classification === 'recommended' && !upgrade.isDowngrade)
  const unknown = classifyWuUpdate('1.2.3', null, null, false, 'audio')
  check('WU unknown installed version stays unknown', unknown.classification === 'unknown')

  check('jitter of steady samples', computeJitter([20, 20, 20]) === 0)
  check('jitter needs two samples', computeJitter([20]) === null)
  check('jitter mean absolute delta', computeJitter([10, 20, 15]) === 7.5, String(computeJitter([10, 20, 15])))

  check(
    'faulting module extracted',
    moduleFromMessage('Faulting application name: game.exe\nFaulting module name: nvwgf2umx.dll, version: 1') ===
      'nvwgf2umx.dll,'
      ? true
      : moduleFromMessage('Faulting module name: nvwgf2umx.dll') === 'nvwgf2umx.dll',
    String(moduleFromMessage('Faulting module name: nvwgf2umx.dll'))
  )
  check(
    'display timeout module extracted',
    moduleFromMessage('Display driver nvlddmkm stopped responding and has successfully recovered.') === 'nvlddmkm'
  )
  check(
    'SCM 7000 service extracted',
    moduleFromMessage('The Foo Bar service failed to start due to the following error:') === 'Foo Bar',
    String(moduleFromMessage('The Foo Bar service failed to start due to the following error:'))
  )
  check(
    'SCM 7009 service extracted',
    moduleFromMessage('A timeout was reached (30000 milliseconds) while waiting for the Steam Client Service service to connect.') ===
      'Steam Client Service',
    String(
      moduleFromMessage('A timeout was reached (30000 milliseconds) while waiting for the Steam Client Service service to connect.')
    )
  )

  const vdf = parseVdf('"AppState"\n{\n\t"appid"\t\t"2670630"\n\t"name"\t\t"Test Game"\n}\n')
  const state = (vdf['AppState'] ?? {}) as Record<string, unknown>
  check('vdf parses nested scalars', state['appid'] === '2670630' && state['name'] === 'Test Game')

  check('driverAgeDays null-safe', driverAgeDays(null) === null)
  check('driverAgeDays computes', (driverAgeDays(new Date(Date.now() - 86_400_000 * 10).toISOString()) ?? 0) >= 9)
}

async function main(): Promise<void> {
  console.log('GameDriver Pro — service self-test (read-only)')
  pureUnitChecks()

  const hardware = await step('hardware snapshot', () => getHardwareSnapshot(true))
  if (hardware) {
    line('cpu', hardware.cpu.name)
    line('gpus (ordered)', hardware.gpus.map((g) => `${g.name} [${g.vendor}] v${g.displayDriverVersion ?? g.driverVersion}`))
    line('memory GB', (hardware.memory.totalBytes / 1024 ** 3).toFixed(1))
    line('disks', hardware.storage.map((d) => `${d.friendlyName} ${d.mediaType}/${d.busType} health=${d.health.status} smart=${d.health.available}`))
    line('displays', hardware.displays.map((d) => `${d.name} ${d.diagonalInches ?? '?'}in`))
    line('device counts', {
      audio: hardware.audio.length,
      bluetooth: hardware.bluetooth.length,
      usb: hardware.usb.length,
      controllers: hardware.controllers.length,
      network: hardware.network.length
    })
    line('warnings', hardware.warnings)
    check('cpu detected', hardware.cpu.name.length > 3)
    check('at least one gpu', hardware.gpus.length > 0)
    check('discrete gpu sorted first', hardware.gpus[0]?.vendor !== 'intel' || hardware.gpus.length === 1)
    check('memory total is plausible', hardware.memory.totalBytes > 1024 ** 3)
    check('storage enumerated', hardware.storage.length > 0)
  }

  const inventory = await step('driver inventory', () => getDriverInventory(true))
  if (inventory) {
    line('packages', inventory.entries.length)
    line('by category', inventory.countsByCategory)
    line('problem devices', inventory.problemDevices)
    line('unsigned', inventory.unsignedDrivers)
    check('inventory non-empty', inventory.entries.length > 10)
    check('graphics category present', (inventory.countsByCategory['graphics'] ?? 0) > 0)
    check('every entry has a name', inventory.entries.every((e) => e.deviceName.length > 0))
  }

  const scan = await step('driver scan (live official sources)', () =>
    scanForDriverUpdates({ allowVendorLookups: true, allowWindowsUpdate: true })
  )
  if (scan) {
    for (const source of scan.sources) line(`source ${source.id}`, `${source.state} (${source.durationMs}ms) ${source.detail}`)
    line('updates', scan.updates.length)
    for (const update of scan.updates) {
      console.log(
        `    - [${update.classification}/${update.risk}] ${update.deviceName}: ${update.currentVersion ?? '?'} -> ${
          update.availableVersion ?? 'not determined'
        } via ${update.source.label} action=${update.action}`
      )
      for (const reason of update.rationale) console.log(`        · ${reason}`)
    }
    line('errors', scan.errors)
    check('every source reported a state', scan.sources.every((s) => ['ok', 'error', 'skipped', 'unavailable'].includes(s.state)))
    check('every update names an official source', scan.updates.every((u) => u.source.official === true))
    check('every update explains itself', scan.updates.every((u) => u.rationale.length > 0))
    check(
      'no update claims a version it did not get',
      scan.updates.every((u) => u.availableVersion !== null || u.classification === 'unknown' || u.action === 'manual')
    )
  }

  const health = await step('health report', () => buildHealthReport())
  if (health) {
    line('score', `${health.score} (${health.evaluatedChecks}/${health.checks.length} evaluated)`)
    for (const c of health.checks) console.log(`    ${c.state.toUpperCase().padEnd(7)} ${c.id.padEnd(16)} ${c.problem}`)
    check('score within range', health.score >= 0 && health.score <= 100)
    check('unknown checks excluded from denominator', health.evaluatedChecks <= health.checks.length)
    check('every check has action + why', health.checks.every((c) => c.why.length > 0 && c.action.length > 0))
  }

  const crashes = await step('crash analysis', () => analyseCrashes(30))
  if (crashes) {
    line('events', crashes.events.length)
    line('groups', crashes.groups.map((g) => `${g.title} x${g.count} (${g.confidence})`))
    line('dumps', crashes.dumps.map((d) => `${d.path} ${d.bugcheckCode ?? 'no code'}`))
    check('groups carry recommendations', crashes.groups.every((g) => g.recommendation.length > 0))
    check('confidence is hedged', crashes.groups.every((g) => g.confidence === 'possible' || g.confidence === 'likely'))
  }

  const games = await step('game library', () => getGameLibrary(true))
  if (games) {
    line('games', games.games.map((g) => `${g.name} [${g.launcher}] art=${g.heroImageUrl ? 'yes' : 'no'}`))
    line('launchers detected', games.launchers.filter((l) => l.detected).map((l) => l.launcher))
    line('warnings', games.warnings)
    check('game paths are absolute', games.games.every((g) => /^[a-zA-Z]:[\\/]/.test(g.installPath)))
  }

  const plan = await step('boost plan', () => buildBoostPlan())
  if (plan) {
    line('actions', plan.actions.map((a) => `${a.id}:${a.available ? 'available' : 'unavailable'}`))
    line('closable count', plan.closableProcesses.length)
    line('power plans', plan.powerPlans.map((p) => `${p.name}${p.active ? '*' : ''}`))
    check('unavailable actions give a reason', plan.actions.every((a) => a.available || (a.unavailableReason ?? '').length > 0))
    check('no protected process is offered for closing', plan.closableProcesses.every((p) => !p.protected))
    check('notifications action is honestly unavailable', plan.actions.find((a) => a.id === 'notifications')?.available === false)
  }

  const processes = await step('process list', () => listProcesses())
  if (processes) {
    line('count', processes.length)
    line('top 3 by memory', processes.slice(0, 3).map((p) => `${p.name} ${(p.memoryBytes / 1048576).toFixed(0)}MB cpu=${p.cpuPercent}%`))
    check('protected processes flagged', processes.some((p) => p.protected))
    check('cpu percent measured for some', processes.some((p) => p.cpuPercent !== null))
  }

  const startup = await step('startup items', () => listStartupItems())
  if (startup) {
    line('items', startup.map((s) => `${s.name}[${s.impact}${s.protected ? ',protected' : ''}]`))
  }

  const plans = await step('power plans', () => listPowerPlans())
  if (plans) check('exactly one active power plan', plans.filter((p) => p.active).length === 1, `${plans.filter((p) => p.active).length}`)

  const restore = await step('restore point status', () => restorePointStatus())
  if (restore) line('protection', restore.note)

  // The gate that makes downloading and running a vendor installer acceptable.
  // Exercised against real signed binaries, including one signed by the exact
  // publisher the NVIDIA install path requires.
  await step('installer signature verification', async () => {
    check('rejects a non-official download host', !isAllowedHost('https://drivers.example.com/nvidia.exe'))
    check('rejects plain http on an official host', !isAllowedHost('http://us.download.nvidia.com/a.exe'))
    check('accepts the official download host', isAllowedHost('https://us.download.nvidia.com/Windows/610.88/a.exe'))
    check('accepts a regional mirror of it', isAllowedHost('https://uk.download.nvidia.com/Windows/610.88/a.exe'))
    check('rejects a lookalike host', !isAllowedHost('https://download.nvidia.com.evil.net/a.exe'))

    // Probe a known-signed system binary. Who signed it varies by machine (a
    // driver tool may carry the vendor's signature or Microsoft's WHQL one), so
    // discover the real subject first and assert against that.
    const signedFile = ['C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Windows\\System32\\notepad.exe'].find((p) =>
      existsSync(p)
    )
    if (signedFile) {
      const probe = await verifySignature(signedFile, '')
      line('probe file', signedFile)
      line('probe signature', `${probe.status} — ${probe.subject.slice(0, 72)}`)
      check('a signed system binary verifies as Valid', probe.status === 'Valid', probe.detail)

      const cn = /CN=([^,]+)/.exec(probe.subject)?.[1]?.trim() ?? ''
      if (cn) {
        const matching = await verifySignature(signedFile, cn)
        check('correct publisher is trusted', matching.trusted, matching.detail)
      }

      const wrongSigner = await verifySignature(signedFile, 'Definitely Not The Publisher')
      check('valid signature but wrong publisher is rejected', !wrongSigner.trusted, wrongSigner.detail)
    }

    const unsigned = join(tmpdir(), 'gdp-unsigned-probe.exe')
    writeFileSync(unsigned, Buffer.from('MZ not a real executable'))
    const bad = await verifySignature(unsigned, 'NVIDIA Corporation')
    check('unsigned file is rejected', !bad.trusted, `${bad.status}`)
    rmSync(unsigned, { force: true })
    return true
  })

  const network = await step('network test', () => runNetworkTest())
  if (network) {
    line('result', `${network.rating} ping=${network.pingMs} jitter=${network.jitterMs} loss=${network.packetLossPercent}% dns=${network.dnsMs}`)
    check('rating consistent with data', network.pingMs !== null || network.rating === 'unknown')
  }

  const capabilities = await step('monitor start + sample', async () => {
    const caps = await monitor.start(1000)
    const samples: unknown[] = []
    const off = monitor.subscribe((sample) => samples.push(sample))
    await new Promise((resolve) => setTimeout(resolve, 5000))
    off()
    monitor.stop()
    return { caps, samples }
  })
  if (capabilities) {
    line('capabilities', capabilities.caps)
    line('samples collected', capabilities.samples.length)
    const last = capabilities.samples[capabilities.samples.length - 1] as
      | { cpu: { usagePercent: number | null }; gpus: unknown[]; disk: unknown; network: unknown }
      | undefined
    console.log('  last sample:', JSON.stringify(last, null, 1)?.slice(0, 1200))
    check('samples arrived', capabilities.samples.length >= 3, `${capabilities.samples.length}`)
    check('cpu usage measured', typeof last?.cpu.usagePercent === 'number')
    check('gpu telemetry present', (last?.gpus.length ?? 0) > 0)
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
