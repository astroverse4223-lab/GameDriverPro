import { shell } from 'electron'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { queryEmitted, runNdjson, runRaw } from './powershell'
import { RESTORE_POINT_STATUS_SCRIPT } from './wmiScripts'
import { isElevated, ELEVATION_HINT } from './elevation'
import { store } from './db'
import { getDriverInventory } from './drivers'
import { lastScanResult } from './driverSources'
import { log, describeError } from './logger'
import type {
  DriverBackupResult,
  InstallOutcome,
  InstallProgress,
  RestorePointResult,
  RollbackInfo
} from '../../shared/types'

/**
 * Driver install / rollback / backup, and Windows System Restore.
 *
 * Two rules shape everything here:
 *  - nothing happens without an explicit, echoed-back confirmation from the UI;
 *  - if Windows does not expose a supported mechanism for something, the app
 *    says so and hands off to Windows' own UI instead of improvising.
 */

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

// --- System restore ---------------------------------------------------------

const RESTORE_POINT_SCRIPT = `
$desc = $env:GDP_ARG_DESC
if (-not $desc) { $desc = 'GameDriver Pro' }
$out = [ordered]@{ ok = $false; message = ''; }
try {
  Checkpoint-Computer -Description $desc -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop
  $out.ok = $true
  $out.message = 'Restore point created.'
} catch {
  $out.ok = $false
  $out.message = $_.Exception.Message
}
ConvertTo-Json -InputObject ([pscustomobject]$out) -Compress
`

export async function restorePointStatus(): Promise<{ enabled: boolean | null; note: string }> {
  const raw = await queryEmitted<{ status: { enabled: boolean | null; mostRecent: string | null } | null }>(
    RESTORE_POINT_STATUS_SCRIPT,
    { timeoutMs: 20_000 }
  ).catch(() => null)

  const enabled = raw?.status?.enabled ?? null
  if (enabled === true) {
    return {
      enabled: true,
      note: raw?.status?.mostRecent
        ? `System protection is on. Most recent restore point: “${raw.status.mostRecent}”.`
        : 'System protection is on for this PC.'
    }
  }
  if (enabled === false) {
    return {
      enabled: false,
      note: 'System protection appears to be turned off, so Windows cannot create restore points. Turn it on in Windows Settings › System › About › System protection.'
    }
  }
  return {
    enabled: null,
    note: 'GameDriver Pro could not determine whether system protection is enabled — this query needs administrator rights.'
  }
}

export async function createRestorePoint(description: string): Promise<RestorePointResult> {
  const status = await restorePointStatus()

  if (!isElevated()) {
    return {
      ok: false,
      message: `Creating a restore point requires administrator rights. ${ELEVATION_HINT}`,
      requiresElevation: true,
      systemProtectionEnabled: status.enabled
    }
  }

  const safeDescription = description.replace(/[\r\n]/g, ' ').slice(0, 220) || 'GameDriver Pro'

  try {
    const raw = await queryEmitted<{ ok: boolean; message: string }>(RESTORE_POINT_SCRIPT, {
      args: { DESC: safeDescription },
      timeoutMs: 180_000
    })
    const ok = raw?.ok === true
    store.addHistory({
      timestamp: Date.now(),
      kind: 'restore-point',
      device: null,
      category: null,
      fromVersion: null,
      toVersion: null,
      result: ok ? 'success' : 'failed',
      source: 'Windows System Restore',
      detail: raw?.message ?? null
    })
    return {
      ok,
      message: ok
        ? 'Restore point created. Note that a restore point can help undo some system changes, but Windows does not guarantee it will recover every situation.'
        : (raw?.message ??
          'Windows did not create a restore point. Windows also limits how often restore points can be created (by default once every 24 hours).'),
      requiresElevation: false,
      systemProtectionEnabled: status.enabled
    }
  } catch (error) {
    return {
      ok: false,
      message: `Restore point failed: ${describeError(error)}`,
      requiresElevation: false,
      systemProtectionEnabled: status.enabled
    }
  }
}

// --- Windows Update driver installation -------------------------------------

/**
 * Installs one specific Windows Update driver package through the Windows Update
 * Agent. Progress is emitted per stage: the agent's synchronous download/install
 * calls do not expose a percentage, so the app reports the real stage and leaves
 * the percentage null rather than animating a fake number.
 */
const INSTALL_SCRIPT = `
$target = $env:GDP_ARG_UPDATEID
$rev = [int]$env:GDP_ARG_REVISION
function Emit($obj) { Write-Output (ConvertTo-Json -InputObject ([pscustomobject]$obj) -Compress) }

try {
  Emit @{ stage = 'preparing'; message = 'Locating the update in Windows Update' }
  $session = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  $searcher.Online = $true
  $result = $searcher.Search("IsInstalled=0 and Type='Driver' and IsHidden=0")

  $match = $null
  foreach ($u in $result.Updates) {
    if ([string]$u.Identity.UpdateID -eq $target -and [int]$u.Identity.RevisionNumber -eq $rev) { $match = $u; break }
  }
  if ($null -eq $match) {
    Emit @{ stage = 'failed'; message = 'Windows Update no longer offers this driver. Run a fresh scan.'; error = 'not-offered' }
    exit 1
  }

  if (-not $match.EulaAccepted) {
    try { $match.AcceptEula() } catch {}
  }

  $coll = New-Object -ComObject Microsoft.Update.UpdateColl
  [void]$coll.Add($match)

  Emit @{ stage = 'downloading'; message = 'Downloading from Windows Update' }
  $downloader = $session.CreateUpdateDownloader()
  $downloader.Updates = $coll
  $dres = $downloader.Download()
  if ($dres.ResultCode -ne 2) {
    Emit @{ stage = 'failed'; message = "Download did not complete (Windows Update result code $($dres.ResultCode))"; error = 'download' }
    exit 1
  }

  Emit @{ stage = 'verifying'; message = 'Windows Update verified the package signature' }

  Emit @{ stage = 'installing'; message = 'Installing driver' }
  $installer = $session.CreateUpdateInstaller()
  $installer.Updates = $coll
  $ires = $installer.Install()
  $reboot = [bool]$ires.RebootRequired
  if ($ires.ResultCode -eq 2) {
    Emit @{ stage = 'done'; message = 'Driver installed'; rebootRequired = $reboot; resultCode = [int]$ires.ResultCode }
  } else {
    Emit @{ stage = 'failed'; message = "Windows Update reported install result code $($ires.ResultCode)"; error = 'install'; resultCode = [int]$ires.ResultCode; rebootRequired = $reboot }
  }
} catch {
  Emit @{ stage = 'failed'; message = $_.Exception.Message; error = 'exception' }
  exit 1
}
`

export interface InstallParams {
  updateId: string
  revision: number
  deviceName: string
  fromVersion: string | null
  toVersion: string | null
  createRestorePoint: boolean
  onProgress: (progress: InstallProgress) => void
}

export async function installWindowsUpdateDriver(params: InstallParams): Promise<InstallOutcome> {
  const { updateId, revision, onProgress } = params
  const progressId = `wu:${updateId}:${revision}`

  if (!GUID_RE.test(updateId) || !Number.isInteger(revision) || revision < 0 || revision > 1_000_000) {
    return { ok: false, rebootRequired: false, message: 'Invalid update identity.', resultCode: null }
  }

  // Confirm the update we are about to install is one this session actually
  // offered — the renderer cannot ask for an arbitrary package.
  const offered = lastScanResult()?.updates.find((u) => u.id === progressId)
  if (!offered) {
    return {
      ok: false,
      rebootRequired: false,
      message: 'That update is not part of the most recent scan results. Run a new scan and try again.',
      resultCode: null
    }
  }
  if (offered.action !== 'install') {
    return {
      ok: false,
      rebootRequired: false,
      message: 'This item is not installable by GameDriver Pro — use the official manufacturer page shown on the card.',
      resultCode: null
    }
  }

  if (!isElevated()) {
    return {
      ok: false,
      rebootRequired: false,
      message: `Installing a driver requires administrator rights. ${ELEVATION_HINT}`,
      resultCode: null
    }
  }

  onProgress({ updateId: progressId, stage: 'preparing', percent: null, message: 'Preparing installation' })

  if (params.createRestorePoint) {
    onProgress({
      updateId: progressId,
      stage: 'restore-point',
      percent: null,
      message: 'Creating a Windows restore point'
    })
    const restore = await createRestorePoint(`GameDriver Pro — before ${params.deviceName} driver update`)
    if (!restore.ok) {
      log.warn('install', `Restore point not created: ${restore.message}`)
      onProgress({
        updateId: progressId,
        stage: 'restore-point',
        percent: null,
        message: `Restore point was not created: ${restore.message}`
      })
    }
  }

  let rebootRequired = false
  let resultCode: number | null = null
  let failure: string | null = null

  try {
    await runNdjson(
      INSTALL_SCRIPT,
      (row) => {
        const line = row as { stage?: string; message?: string; rebootRequired?: boolean; resultCode?: number; error?: string }
        const stage = (line.stage ?? 'installing') as InstallProgress['stage']
        if (typeof line.rebootRequired === 'boolean') rebootRequired = line.rebootRequired
        if (typeof line.resultCode === 'number') resultCode = line.resultCode
        if (stage === 'failed') failure = line.message ?? 'Installation failed.'
        onProgress({
          updateId: progressId,
          stage,
          percent: null,
          message: line.message ?? '',
          rebootRequired,
          ...(line.error ? { error: line.error } : {})
        })
      },
      { args: { UPDATEID: updateId, REVISION: String(revision) }, timeoutMs: 45 * 60_000 }
    )
  } catch (error) {
    failure = describeError(error)
  }

  const ok = failure === null
  store.addHistory({
    timestamp: Date.now(),
    kind: 'driver-install',
    device: params.deviceName,
    category: offered.category,
    fromVersion: params.fromVersion,
    toVersion: params.toVersion,
    result: ok ? 'success' : 'failed',
    source: 'Windows Update',
    detail: ok ? (rebootRequired ? 'Installed — restart required' : 'Installed') : failure
  })

  if (ok) {
    // Force the next inventory read to reflect the new driver.
    void getDriverInventory(true).catch(() => undefined)
    onProgress({
      updateId: progressId,
      stage: 'done',
      percent: 100,
      message: rebootRequired ? 'Installed. A restart is required to finish.' : 'Installed.',
      rebootRequired
    })
  }

  return {
    ok,
    rebootRequired,
    message: ok
      ? rebootRequired
        ? 'Driver installed. Restart Windows to complete the change.'
        : 'Driver installed.'
      : (failure ?? 'Installation failed.'),
    resultCode
  }
}

// --- Rollback ---------------------------------------------------------------

export async function getRollbackInfo(deviceId: string): Promise<RollbackInfo> {
  const inventory = await getDriverInventory(false)
  const entry = inventory.entries.find((e) => e.id === deviceId || e.deviceId === deviceId)

  // The app's own history is the only reliable record of what the previous
  // version was, since Windows does not expose the backup package's version.
  const previous =
    store
      .listHistory(500)
      .find(
        (record) =>
          record.kind === 'driver-install' &&
          record.result === 'success' &&
          record.device !== null &&
          entry !== undefined &&
          record.device.toLowerCase() === entry.deviceName.toLowerCase()
      )?.fromVersion ?? null

  return {
    deviceId,
    deviceName: entry?.deviceName ?? 'Unknown device',
    currentVersion: entry?.displayVersion ?? entry?.driverVersion ?? null,
    previousVersion: previous,
    // Windows keeps at most one backup driver package per device, and exposes
    // rollback only through Device Manager's own "Roll Back Driver" button.
    // There is no supported API or command-line equivalent, so the app does not
    // pretend to have one.
    rollbackAvailable: false,
    reason:
      'Windows only exposes driver rollback through Device Manager’s own “Roll Back Driver” button — there is no supported API or command for it, and GameDriver Pro will not fake one by deleting driver files. Use the button below to open Device Manager at this device, then use Driver › Roll Back Driver.'
  }
}

export async function openDeviceManagerFor(deviceId: string): Promise<{ ok: boolean; message: string }> {
  // Only ever pass through an instance ID that Windows itself reported.
  const inventory = await getDriverInventory(false)
  const entry = inventory.entries.find((e) => e.id === deviceId || e.deviceId === deviceId)
  const instanceId = entry?.deviceId ?? null

  try {
    if (instanceId) {
      await runRaw(
        'Start-Process -FilePath "rundll32.exe" -ArgumentList @("devmgr.dll,DeviceProperties_RunDLL", "/DeviceID", $env:GDP_ARG_DEVID) -WindowStyle Normal',
        { args: { DEVID: instanceId }, timeoutMs: 15_000, tolerant: true }
      )
      return {
        ok: true,
        message: 'Opened this device’s properties in Device Manager. Use the Driver tab › Roll Back Driver.'
      }
    }
    await runRaw('Start-Process -FilePath "devmgmt.msc"', { timeoutMs: 15_000, tolerant: true })
    return { ok: true, message: 'Opened Device Manager.' }
  } catch (error) {
    return { ok: false, message: `Could not open Device Manager: ${describeError(error)}` }
  }
}

// --- Driver backup ----------------------------------------------------------

const BACKUP_SCRIPT = `
$dest = $env:GDP_ARG_DEST
$out = [ordered]@{ ok = $false; message = ''; }
try {
  if (-not (Test-Path -LiteralPath $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
  $result = & pnputil.exe /export-driver * $dest 2>&1
  $text = ($result | Out-String)
  $out.message = $text.Trim()
  $out.ok = ($LASTEXITCODE -eq 0)
} catch {
  $out.message = $_.Exception.Message
}
ConvertTo-Json -InputObject ([pscustomobject]$out) -Compress
`

export async function backupDrivers(destination: string): Promise<DriverBackupResult> {
  if (!isElevated()) {
    return {
      ok: false,
      destination: null,
      driverCount: 0,
      message: `Exporting driver packages requires administrator rights. ${ELEVATION_HINT}`,
      requiresElevation: true
    }
  }

  // The renderer only ever supplies a folder chosen through the native dialog.
  if (!destination || /[\r\n"|<>]/.test(destination)) {
    return { ok: false, destination: null, driverCount: 0, message: 'Invalid destination folder.', requiresElevation: false }
  }

  try {
    if (!existsSync(destination)) mkdirSync(destination, { recursive: true })

    const raw = await queryEmitted<{ ok: boolean; message: string }>(BACKUP_SCRIPT, {
      args: { DEST: destination },
      timeoutMs: 15 * 60_000
    })

    // pnputil writes one folder per exported driver package — count them rather
    // than trusting a number parsed out of console text.
    let count = 0
    try {
      count = readdirSync(destination, { withFileTypes: true }).filter((e) => e.isDirectory()).length
    } catch {
      count = 0
    }

    const ok = raw?.ok === true && count > 0
    store.addHistory({
      timestamp: Date.now(),
      kind: 'driver-backup',
      device: null,
      category: null,
      fromVersion: null,
      toVersion: null,
      result: ok ? 'success' : 'failed',
      source: 'pnputil /export-driver',
      detail: ok ? `${count} driver package(s) exported to ${destination}` : (raw?.message ?? null)
    })

    return {
      ok,
      destination,
      driverCount: count,
      message: ok
        ? `Exported ${count} third-party driver package(s) to ${destination}. Windows in-box drivers are not exported — Windows can always reinstall those itself.`
        : (raw?.message ?? 'pnputil did not export any driver packages.'),
      requiresElevation: false
    }
  } catch (error) {
    return {
      ok: false,
      destination,
      driverCount: 0,
      message: `Driver export failed: ${describeError(error)}`,
      requiresElevation: false
    }
  }
}

export async function openFolder(path: string): Promise<{ ok: boolean; message: string }> {
  if (!existsSync(path)) return { ok: false, message: 'That folder no longer exists.' }
  const error = await shell.openPath(path)
  return error ? { ok: false, message: error } : { ok: true, message: 'Opened.' }
}
