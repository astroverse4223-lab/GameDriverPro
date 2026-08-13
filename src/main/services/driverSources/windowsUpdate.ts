import { queryEmitted } from '../powershell'
import { compareVersions } from '../drivers'
import { categoryFromClass } from '../classify'
import { log, describeError } from '../logger'
import type { DriverSource, SourceContext, SourceResult } from './types'
import type { DriverEntry, DriverUpdate, RiskLevel, UpdateClassification } from '../../../shared/types'

/**
 * Microsoft Update as a driver source, via the Windows Update Agent COM API —
 * the same mechanism Settings › Windows Update uses. Nothing is scraped and
 * nothing is downloaded during a scan; this only asks Windows what it is
 * offering for the hardware in this machine.
 */

const SEARCH_SCRIPT = `
$out = [ordered]@{}
$rows = @()
$err = $null
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  $searcher.Online = $true
  $result = $searcher.Search("IsInstalled=0 and Type='Driver' and IsHidden=0")
  foreach ($u in $result.Updates) {
    $ver = $null
    try { if ($u.DriverVerVersion) { $ver = [string]$u.DriverVerVersion } } catch {}
    $date = $null
    try { if ($u.DriverVerDate) { $date = ([datetime]$u.DriverVerDate).ToString('o') } } catch {}
    $rows += [pscustomobject]@{
      title      = [string]$u.Title
      updateId   = [string]$u.Identity.UpdateID
      revision   = [int]$u.Identity.RevisionNumber
      version    = $ver
      driverDate = $date
      provider   = $(try { [string]$u.DriverProvider } catch { $null })
      model      = $(try { [string]$u.DriverModel } catch { $null })
      hardwareId = $(try { [string]$u.DriverHardwareID } catch { $null })
      driverClass= $(try { [string]$u.DriverClass } catch { $null })
      sizeBytes  = $(try { [int64]$u.MaxDownloadSize } catch { $null })
      severity   = $(try { [string]$u.MsrcSeverity } catch { $null })
      downloaded = $(try { [bool]$u.IsDownloaded } catch { $false })
      supportUrl = $(try { [string]$u.SupportUrl } catch { $null })
    }
  }
  $out.resultCode = [int]$result.ResultCode
} catch {
  $err = $_.Exception.Message
  $out.resultCode = -1
}
$out.updates = @($rows)
$out.error = $err
ConvertTo-Json -InputObject ([pscustomobject]$out) -Depth 5 -Compress
`

interface RawWuResponse {
  resultCode: number
  updates: RawWuUpdate[] | RawWuUpdate | null
  error: string | null
}

interface RawWuUpdate {
  title: string
  updateId: string
  revision: number
  version: string | null
  driverDate: string | null
  provider: string | null
  model: string | null
  hardwareId: string | null
  driverClass: string | null
  sizeBytes: number | null
  severity: string | null
  downloaded: boolean
  supportUrl: string | null
}

function arr<T>(value: T[] | T | null | undefined): T[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * Windows Update titles follow "Vendor - Class - Version", e.g.
 * "Intel Corporation - Display - 30.0.100.9805". When the COM object does not
 * surface DriverVerVersion (it is frequently blank), the version in the title is
 * still Microsoft's own data — not a guess.
 */
export function versionFromTitle(title: string): string | null {
  const match = /(\d+(?:\.\d+){1,3})\s*$/.exec(title.trim())
  return match?.[1] ?? null
}

/** Map the WUA driver class to the app's categories. */
function categoryFromDriverClass(driverClass: string | null, model: string | null): DriverUpdate['category'] {
  const cls = (driverClass ?? '').toLowerCase()
  if (cls === 'video' || cls === 'display') return 'graphics'
  if (cls === 'net') return categoryFromClass('NET', model)
  if (cls === 'media' || cls === 'audioendpoint') return 'audio'
  if (cls === 'bluetooth') return 'bluetooth'
  if (cls === 'usb') return 'usb'
  if (cls === 'hdc' || cls === 'diskdrive' || cls === 'scsiadapter') return 'storage'
  if (cls === 'system') return 'chipset'
  if (cls === 'printer' || cls === 'printqueue') return 'printer'
  if (cls === 'hidclass') return 'input'
  if (cls === 'firmware') return 'motherboard'
  return categoryFromClass(driverClass, model)
}

/** Find the installed driver this offer would replace, by hardware ID. */
function matchInstalled(raw: RawWuUpdate, drivers: DriverEntry[]): DriverEntry | null {
  const hardwareId = raw.hardwareId?.trim().toLowerCase()
  if (hardwareId) {
    const byHardwareId = drivers.find((entry) =>
      entry.hardwareIds.some((id) => id.trim().toLowerCase() === hardwareId)
    )
    if (byHardwareId) return byHardwareId
  }
  const model = raw.model?.trim().toLowerCase()
  if (model) {
    const byName = drivers.find((entry) => entry.deviceName.trim().toLowerCase() === model)
    if (byName) return byName
  }
  return null
}

/**
 * Classify a Windows Update driver offer.
 *
 * The important real-world case this handles honestly: Windows Update regularly
 * offers an OLDER driver than the one already installed (a vendor package
 * usually outranks Microsoft's generic one). The app says so plainly instead of
 * counting it as an available upgrade.
 */
export function classifyWuUpdate(
  offered: string | null,
  installed: string | null,
  severity: string | null,
  deviceHasProblem: boolean,
  category: DriverUpdate['category']
): { classification: UpdateClassification; risk: RiskLevel; rationale: string[]; isDowngrade: boolean } {
  const rationale: string[] = []
  const comparison = compareVersions(offered, installed)
  const isDowngrade = comparison !== null && comparison <= 0

  if (isDowngrade) {
    rationale.push(
      comparison === 0
        ? `Windows Update is offering the same version you already have (${offered}).`
        : `Windows Update is offering ${offered}, which is older than your installed ${installed}.`
    )
    rationale.push(
      'This normally happens when a manufacturer driver is installed and Microsoft only distributes a generic one. Installing it would move you backwards.'
    )
    rationale.push('Not recommended — no action needed.')
    return { classification: 'optional', risk: 'medium', rationale, isDowngrade: true }
  }

  if (deviceHasProblem) {
    rationale.push('Windows currently reports a problem with this device.')
    rationale.push('Microsoft is offering a driver for it, which is a low-risk first thing to try.')
    return { classification: 'critical', risk: 'low', rationale, isDowngrade: false }
  }

  if (severity && /critical|important/i.test(severity)) {
    rationale.push(`Microsoft marks this driver update as ${severity}.`)
    return { classification: 'critical', risk: 'low', rationale, isDowngrade: false }
  }

  if (comparison === null) {
    rationale.push(
      installed
        ? `The offered version (${offered ?? 'unknown'}) cannot be reliably compared with your installed version (${installed}).`
        : 'GameDriver Pro could not determine which driver version is currently installed for this device.'
    )
    rationale.push('Shown for information — verify against the manufacturer before installing.')
    return { classification: 'unknown', risk: 'unknown', rationale, isDowngrade: false }
  }

  rationale.push(`Windows Update is offering a newer driver (${installed ?? 'unknown'} → ${offered}).`)
  if (category === 'graphics') {
    rationale.push(
      'Microsoft distributes graphics drivers later and less often than the GPU vendor does, so the vendor’s own package is usually the better source for gaming.'
    )
    return { classification: 'optional', risk: 'low', rationale, isDowngrade: false }
  }
  if (['chipset', 'audio', 'network', 'wifi', 'bluetooth', 'storage'].includes(category)) {
    rationale.push('This is a component that affects system stability, so a newer signed driver from Microsoft is worth taking.')
    return { classification: 'recommended', risk: 'low', rationale, isDowngrade: false }
  }
  rationale.push('No specific gaming benefit is claimed for this device class — keeping your current driver is reasonable.')
  return { classification: 'optional', risk: 'low', rationale, isDowngrade: false }
}

export const windowsUpdateSource: DriverSource = {
  id: 'windows-update',
  label: 'Windows Update (Microsoft)',
  kind: 'windows-update',

  applicable(ctx: SourceContext): boolean {
    return ctx.allowNetwork
  },

  async check(ctx: SourceContext): Promise<SourceResult> {
    const started = Date.now()
    let raw: RawWuResponse | null = null
    try {
      // A live Microsoft Update scan routinely takes 20–60 seconds.
      raw = await queryEmitted<RawWuResponse>(SEARCH_SCRIPT, { timeoutMs: 180_000 })
    } catch (error) {
      const message = describeError(error)
      log.warn('windows-update', `Search failed: ${message}`)
      return {
        status: {
          id: 'windows-update',
          label: 'Windows Update (Microsoft)',
          state: 'error',
          detail: `Could not query Windows Update: ${message}`
        },
        updates: []
      }
    }

    if (raw?.error) {
      return {
        status: {
          id: 'windows-update',
          label: 'Windows Update (Microsoft)',
          state: 'error',
          detail: `Windows Update refused the query: ${raw.error}`
        },
        updates: []
      }
    }

    const rows = arr(raw?.updates)
    const updates: DriverUpdate[] = rows.map((row) => {
      const installedEntry = matchInstalled(row, ctx.drivers)
      const offered = row.version && row.version.trim().length > 0 ? row.version.trim() : versionFromTitle(row.title)
      const category = categoryFromDriverClass(row.driverClass, row.model)
      const installed = installedEntry?.driverVersion ?? null
      const { classification, risk, rationale, isDowngrade } = classifyWuUpdate(
        offered,
        installed,
        row.severity,
        installedEntry?.status === 'error',
        category
      )

      return {
        id: `wu:${row.updateId}:${row.revision}`,
        deviceName: row.model ?? row.title,
        category,
        currentVersion: installed,
        availableVersion: offered,
        releaseDate: row.driverDate,
        source: {
          id: 'windows-update',
          label: `Windows Update · ${row.provider ?? 'Microsoft'}`,
          official: true,
          url: row.supportUrl && row.supportUrl.startsWith('http') ? row.supportUrl : null,
          kind: 'windows-update'
        },
        classification,
        risk,
        rationale,
        // Windows Update packages are signed and installable through the same
        // agent Windows itself uses — except downgrades, which the app will not
        // offer as a one-click action.
        action: isDowngrade ? 'manual' : 'install',
        download: null,
        sizeBytes: row.sizeBytes,
        updateIdentity: { updateId: row.updateId, revision: row.revision },
        verified: true,
        verificationNote:
          'Distributed and signature-checked by Windows Update itself; GameDriver Pro does not modify the package.'
      }
    })

    return {
      status: {
        id: 'windows-update',
        label: 'Windows Update (Microsoft)',
        state: 'ok',
        detail:
          rows.length === 0
            ? 'Windows Update is not offering any driver updates for this PC.'
            : `Windows Update returned ${rows.length} driver offer(s) in ${Math.round((Date.now() - started) / 1000)}s.`
      },
      updates
    }
  }
}
