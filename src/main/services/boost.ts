import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { queryEmitted, runRaw } from './powershell'
import { POWER_PLAN_SCRIPT, PROCESS_SCRIPT, STARTUP_SCRIPT } from './wmiScripts'
import { classifyProcess, isProtectedStartup, startupImpact } from './classify'
import { store } from './db'
import { monitor } from './monitor'
import { log, describeError } from './logger'
import type {
  BoostAction,
  BoostPlan,
  BoostResult,
  PowerPlan,
  ProcessInfo,
  StartupItem
} from '../../shared/types'

/**
 * Game Boost and Gaming Mode.
 *
 * Design constraints taken seriously:
 *  - every action is shown, explained and individually opt-in before anything runs;
 *  - Windows-critical processes are never offered for closing, let alone closed;
 *  - actions the platform does not support are listed as unavailable with the
 *    reason, instead of being quietly skipped or faked;
 *  - nothing claims to "free RAM" — that is not a thing this app can honestly do.
 */

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

interface RawProcessRow {
  pid: number
  name: string
  description: string | null
  memoryBytes: number
  cpuPercent: number | null
  gpuPercent: number | null
  windowTitle: string | null
}

interface RawStartupRow {
  name: string
  command: string | null
  location: string
  user: string | null
  enabled: boolean
}

function arr<T>(value: T[] | T | null | undefined): T[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

// --- Processes --------------------------------------------------------------

export async function listProcesses(): Promise<ProcessInfo[]> {
  const raw = await queryEmitted<{ processes: RawProcessRow[] | RawProcessRow | null }>(PROCESS_SCRIPT, {
    timeoutMs: 30_000
  }).catch((error) => {
    log.warn('boost', `Process list failed: ${describeError(error)}`)
    return null
  })

  const rows = arr(raw?.processes)
  const merged = new Map<string, ProcessInfo>()

  for (const row of rows) {
    const { category, isProtected } = classifyProcess(row.name)
    // Chromium-based apps run a dozen processes under one name; present them as
    // one row with summed memory so the user sees the real cost of "Chrome".
    const key = row.name.toLowerCase()
    const existing = merged.get(key)
    if (existing) {
      existing.memoryBytes += row.memoryBytes
      if (row.cpuPercent !== null) existing.cpuPercent = (existing.cpuPercent ?? 0) + row.cpuPercent
      if (!existing.windowTitle && row.windowTitle) existing.windowTitle = row.windowTitle
      continue
    }
    merged.set(key, {
      pid: row.pid,
      name: row.name,
      description: row.description,
      memoryBytes: row.memoryBytes,
      cpuPercent: row.cpuPercent,
      category,
      protected: isProtected,
      windowTitle: row.windowTitle
    })
  }

  return [...merged.values()]
    .map((p) => ({ ...p, cpuPercent: p.cpuPercent === null ? null : Math.round(p.cpuPercent * 10) / 10 }))
    .sort((a, b) => b.memoryBytes - a.memoryBytes)
}

// --- Startup ---------------------------------------------------------------

export async function listStartupItems(): Promise<StartupItem[]> {
  const raw = await queryEmitted<{ startup: RawStartupRow[] | RawStartupRow | null }>(STARTUP_SCRIPT, {
    timeoutMs: 30_000
  }).catch((error) => {
    log.warn('boost', `Startup list failed: ${describeError(error)}`)
    return null
  })

  const seen = new Set<string>()
  const items: StartupItem[] = []
  for (const row of arr(raw?.startup)) {
    const key = `${row.name}|${row.location}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      name: row.name,
      command: row.command,
      location: row.location,
      enabled: row.enabled,
      impact: startupImpact(row.name, row.command),
      publisher: null,
      protected: isProtectedStartup(row.name, row.command)
    })
  }
  return items.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2, unknown: 3 }
    return order[a.impact] - order[b.impact] || a.name.localeCompare(b.name)
  })
}

/**
 * Enable / disable a startup entry the same way Task Manager does: through the
 * StartupApproved key, which leaves the original Run entry untouched so the
 * change is fully reversible.
 */
const STARTUP_TOGGLE_SCRIPT = `
$name = $env:GDP_ARG_NAME
$enable = ($env:GDP_ARG_ENABLE -eq '1')
$scope = $env:GDP_ARG_SCOPE
$out = [ordered]@{ ok = $false; message = '' }

$roots = @()
if ($scope -eq 'machine') {
  $roots = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run')
} else {
  $roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run')
}
if ($scope -eq 'folder') {
  $roots = @(
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder',
    'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'
  )
}

try {
  $bytes = New-Object byte[] 12
  if ($enable) { $bytes[0] = 2 } else { $bytes[0] = 3 }
  $done = $false
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { New-Item -Path $root -Force | Out-Null }
    Set-ItemProperty -Path $root -Name $name -Value $bytes -Type Binary -ErrorAction Stop
    $done = $true
    break
  }
  $out.ok = $done
  $out.message = $(if ($done) { 'Updated.' } else { 'No writable StartupApproved key was found.' })
} catch {
  $out.message = $_.Exception.Message
}
ConvertTo-Json -InputObject ([pscustomobject]$out) -Compress
`

export async function setStartupEnabled(
  name: string,
  location: string,
  enabled: boolean
): Promise<{ ok: boolean; message: string }> {
  if (!name || /[\r\n]/.test(name)) return { ok: false, message: 'Invalid startup entry name.' }

  const items = await listStartupItems()
  const item = items.find((i) => i.name === name && i.location === location)
  if (!item) return { ok: false, message: 'That startup entry no longer exists.' }
  if (item.protected) {
    return {
      ok: false,
      message: `“${name}” looks like a Windows or device-driver component, so GameDriver Pro will not disable it.`
    }
  }

  const scope = /startup/i.test(location) && !/\\Run$/i.test(location) ? 'folder' : /HKLM|machine/i.test(location) ? 'machine' : 'user'

  try {
    const raw = await queryEmitted<{ ok: boolean; message: string }>(STARTUP_TOGGLE_SCRIPT, {
      args: { NAME: name, ENABLE: enabled ? '1' : '0', SCOPE: scope },
      timeoutMs: 20_000
    })
    const ok = raw?.ok === true
    return {
      ok,
      message: ok
        ? `${name} will ${enabled ? 'start' : 'not start'} with Windows. You can change this back at any time here or in Task Manager.`
        : (raw?.message ?? 'Windows refused the change.')
    }
  } catch (error) {
    return { ok: false, message: `Could not change startup entry: ${describeError(error)}` }
  }
}

// --- Power plans -----------------------------------------------------------

export async function listPowerPlans(): Promise<PowerPlan[]> {
  const raw = await queryEmitted<{ plans: { plans: PowerPlan[] | PowerPlan | null; active: string | null } | null }>(
    POWER_PLAN_SCRIPT,
    { timeoutMs: 20_000 }
  ).catch((error) => {
    log.warn('boost', `Power plan list failed: ${describeError(error)}`)
    return null
  })
  return arr(raw?.plans?.plans).map((plan) => ({ ...plan, name: plan.name.trim() }))
}

export async function setPowerPlan(guid: string): Promise<{ ok: boolean; message: string }> {
  if (!GUID_RE.test(guid)) return { ok: false, message: 'Invalid power plan identifier.' }
  const plans = await listPowerPlans()
  const plan = plans.find((p) => p.guid.toLowerCase() === guid.toLowerCase())
  if (!plan) return { ok: false, message: 'That power plan is not available on this PC.' }

  try {
    await runRaw('& powercfg /setactive $env:GDP_ARG_GUID', { args: { GUID: guid }, timeoutMs: 20_000 })
    return { ok: true, message: `Power plan set to “${plan.name}”.` }
  } catch (error) {
    return { ok: false, message: `Could not change the power plan: ${describeError(error)}` }
  }
}

// --- Shader caches ---------------------------------------------------------

/**
 * Shader caches are regenerated on demand, so clearing them is safe — but only
 * these exact vendor cache folders are ever touched, and only inside LOCALAPPDATA.
 */
function shaderCachePaths(): { label: string; path: string }[] {
  const local = process.env['LOCALAPPDATA']
  if (!local) return []
  return [
    { label: 'NVIDIA DirectX shader cache', path: join(local, 'NVIDIA', 'DXCache') },
    { label: 'NVIDIA OpenGL shader cache', path: join(local, 'NVIDIA', 'GLCache') },
    { label: 'AMD DirectX shader cache', path: join(local, 'AMD', 'DxCache') },
    { label: 'Windows D3D shader cache', path: join(local, 'D3DSCache') }
  ].filter((entry) => existsSync(entry.path))
}

async function clearShaderCaches(): Promise<{ ok: boolean; message: string }> {
  const targets = shaderCachePaths()
  if (targets.length === 0) {
    return { ok: false, message: 'No vendor shader cache folders were found on this PC.' }
  }
  const cleared: string[] = []
  const failed: string[] = []
  for (const target of targets) {
    try {
      await rm(target.path, { recursive: true, force: true })
      cleared.push(target.label)
    } catch (error) {
      failed.push(`${target.label} (${describeError(error)})`)
    }
  }
  return {
    ok: cleared.length > 0,
    message: [
      cleared.length > 0 ? `Cleared: ${cleared.join(', ')}.` : null,
      failed.length > 0 ? `Could not clear: ${failed.join(', ')}.` : null,
      cleared.length > 0 ? 'Games will rebuild these caches, so the first launch after this may stutter briefly.' : null
    ]
      .filter(Boolean)
      .join(' ')
  }
}

// --- Boost plan / apply ----------------------------------------------------

const HIGH_PERFORMANCE_HINT = /high performance|ultimate performance|balanced/i

interface RevertState {
  token: string
  previousPowerPlan: string | null
  createdAt: number
}

let revertState: RevertState | null = null

export async function buildBoostPlan(): Promise<BoostPlan> {
  const [processes, plans] = await Promise.all([listProcesses(), listPowerPlans()])
  const active = plans.find((p) => p.active)?.guid ?? null
  const caches = shaderCachePaths()

  const closable = processes.filter(
    (p) =>
      !p.protected &&
      p.category !== 'system' &&
      (p.memoryBytes > 120 * 1024 * 1024 || (p.cpuPercent ?? 0) > 2) &&
      ['browser', 'launcher', 'updater', 'communication', 'recording', 'overlay', 'other'].includes(p.category)
  )

  const actions: BoostAction[] = [
    {
      id: 'close-apps',
      label: 'Close selected background apps',
      detail:
        'Asks the apps you tick below to close, starting with a normal close request. Windows components and anything GameDriver Pro considers system-critical are never listed.',
      enabled: closable.length > 0,
      reversible: false,
      requiresElevation: false,
      available: closable.length > 0,
      unavailableReason: closable.length > 0 ? null : 'No non-essential background apps are using significant resources.'
    },
    {
      id: 'power-plan',
      label: 'Switch to a high-performance power plan',
      detail:
        'Selects the highest-performance plan Windows offers on this PC. The current plan is remembered so it can be put back with one click.',
      enabled: plans.length > 1,
      reversible: true,
      requiresElevation: false,
      available: plans.length > 1,
      unavailableReason: plans.length > 1 ? null : 'Only one power plan is available on this PC.'
    },
    {
      id: 'shader-cache',
      label: 'Clear vendor shader caches',
      detail: `Deletes only the regenerable GPU shader cache folders (${caches.map((c) => c.label).join(', ') || 'none found'}). Games rebuild them automatically.`,
      enabled: false,
      reversible: false,
      requiresElevation: false,
      available: caches.length > 0,
      unavailableReason: caches.length > 0 ? null : 'No vendor shader cache folders exist on this PC.'
    },
    {
      id: 'notifications',
      label: 'Pause Windows notifications',
      detail:
        'Windows does not provide a supported way for an application to turn Focus Assist / Do Not Disturb on or off. Use Quick Settings (Win+A) to enable it — GameDriver Pro will not write to undocumented registry keys to fake this.',
      enabled: false,
      reversible: true,
      requiresElevation: false,
      available: false,
      unavailableReason: 'No supported Windows API exists for toggling Focus Assist.'
    },
    {
      id: 'start-monitor',
      label: 'Start the performance monitor',
      detail: 'Begins live CPU, GPU, memory, disk and network sampling so you can compare before and after.',
      enabled: true,
      reversible: true,
      requiresElevation: false,
      available: true,
      unavailableReason: null
    }
  ]

  return { actions, closableProcesses: closable, powerPlans: plans, activePowerPlan: active }
}

export async function applyBoost(
  actionIds: string[],
  closePids: number[],
  powerPlanGuid: string | null
): Promise<BoostResult> {
  const applied: BoostResult['applied'] = []
  const plans = await listPowerPlans()
  const previousPlan = plans.find((p) => p.active)?.guid ?? null

  if (actionIds.includes('close-apps')) {
    const result = await closeProcesses(closePids)
    applied.push({ id: 'close-apps', ok: result.ok, message: result.message })
  }

  if (actionIds.includes('power-plan')) {
    const target =
      (powerPlanGuid && plans.find((p) => p.guid.toLowerCase() === powerPlanGuid.toLowerCase())) ??
      plans.find((p) => /ultimate performance/i.test(p.name)) ??
      plans.find((p) => /high performance/i.test(p.name)) ??
      plans.find((p) => HIGH_PERFORMANCE_HINT.test(p.name)) ??
      null
    if (!target) {
      applied.push({ id: 'power-plan', ok: false, message: 'No high-performance power plan is available on this PC.' })
    } else if (target.active) {
      applied.push({ id: 'power-plan', ok: true, message: `Already using “${target.name}”.` })
    } else {
      const result = await setPowerPlan(target.guid)
      applied.push({ id: 'power-plan', ...result })
    }
  }

  if (actionIds.includes('shader-cache')) {
    const result = await clearShaderCaches()
    applied.push({ id: 'shader-cache', ...result })
  }

  if (actionIds.includes('start-monitor')) {
    try {
      await monitor.start()
      applied.push({ id: 'start-monitor', ok: true, message: 'Performance monitoring started.' })
    } catch (error) {
      applied.push({ id: 'start-monitor', ok: false, message: describeError(error) })
    }
  }

  const token = `boost-${Date.now()}`
  revertState = { token, previousPowerPlan: previousPlan, createdAt: Date.now() }

  store.addHistory({
    timestamp: Date.now(),
    kind: 'boost',
    device: null,
    category: null,
    fromVersion: null,
    toVersion: null,
    result: applied.every((a) => a.ok) ? 'success' : 'failed',
    source: 'Game Boost',
    detail: applied.map((a) => `${a.id}: ${a.ok ? 'ok' : 'failed'}`).join(', ')
  })

  return { applied, revertToken: revertState.previousPowerPlan ? token : null }
}

export async function revertBoost(token: string): Promise<{ ok: boolean; message: string }> {
  if (!revertState || revertState.token !== token) {
    return { ok: false, message: 'There is nothing to undo from this session.' }
  }
  const guid = revertState.previousPowerPlan
  revertState = null
  if (!guid) return { ok: false, message: 'The previous power plan was not recorded.' }
  const result = await setPowerPlan(guid)
  return {
    ok: result.ok,
    message: result.ok
      ? `${result.message} Apps that were closed are not reopened automatically.`
      : result.message
  }
}

/**
 * Ask processes to close. A normal close request goes first; only if the process
 * is still running afterwards is it terminated, and protected processes are
 * filtered out before we get here.
 */
const CLOSE_SCRIPT = `
$ids = ($env:GDP_ARG_PIDS -split ',') | Where-Object { $_ -match '^\\d+$' } | ForEach-Object { [int]$_ }
$results = @()
foreach ($id in $ids) {
  $p = $null
  try { $p = Get-Process -Id $id -ErrorAction Stop } catch { $results += [pscustomobject]@{ pid = $id; ok = $false; message = 'Already closed' }; continue }
  $name = $p.ProcessName
  try {
    $closed = $false
    try { $closed = $p.CloseMainWindow() } catch {}
    if ($closed) { Start-Sleep -Milliseconds 1500 }
    $still = $null
    try { $still = Get-Process -Id $id -ErrorAction Stop } catch { $still = $null }
    if ($null -ne $still) {
      Stop-Process -Id $id -ErrorAction Stop
      $results += [pscustomobject]@{ pid = $id; ok = $true; message = "$name closed" }
    } else {
      $results += [pscustomobject]@{ pid = $id; ok = $true; message = "$name closed" }
    }
  } catch {
    $results += [pscustomobject]@{ pid = $id; ok = $false; message = "$name could not be closed: $($_.Exception.Message)" }
  }
}
ConvertTo-Json -InputObject ([pscustomobject]@{ results = @($results) }) -Depth 4 -Compress
`

async function closeProcesses(pids: number[]): Promise<{ ok: boolean; message: string }> {
  const wanted = pids.filter((pid) => Number.isInteger(pid) && pid > 4)
  if (wanted.length === 0) return { ok: false, message: 'No processes were selected.' }

  // Re-check against the live list so a protected process can never be closed,
  // even if the renderer asked for it.
  const live = await listProcesses()
  const allowed = wanted.filter((pid) => {
    const match = live.find((p) => p.pid === pid)
    return match !== undefined && !match.protected && match.category !== 'system'
  })
  const refused = wanted.length - allowed.length

  if (allowed.length === 0) {
    return { ok: false, message: 'None of the selected processes may be closed by GameDriver Pro.' }
  }

  try {
    const raw = await queryEmitted<{ results: { pid: number; ok: boolean; message: string }[] | null }>(CLOSE_SCRIPT, {
      args: { PIDS: allowed.join(',') },
      timeoutMs: 60_000
    })
    const results = arr(raw?.results)
    const okCount = results.filter((r) => r.ok).length
    const failures = results.filter((r) => !r.ok).map((r) => r.message)
    return {
      ok: okCount > 0,
      message: [
        `${okCount} of ${allowed.length} app(s) closed.`,
        refused > 0 ? `${refused} protected process(es) were skipped.` : null,
        failures.length > 0 ? failures.slice(0, 3).join('; ') : null
      ]
        .filter(Boolean)
        .join(' ')
    }
  } catch (error) {
    return { ok: false, message: `Could not close apps: ${describeError(error)}` }
  }
}
