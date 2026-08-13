import { fetchJson, fetchText, isAllowedHost, parseLookupValues } from '../http'
import { compareVersions, driverAgeDays } from '../drivers'
import { store } from '../db'
import { log, describeError } from './../logger'
import type { DriverSource, SourceContext, SourceResult } from './types'
import type { DriverUpdate, GpuInfo, RiskLevel, UpdateClassification } from '../../../shared/types'

/**
 * NVIDIA's own driver-lookup service — the same endpoints nvidia.com's Drivers
 * page uses. Product and OS identifiers are resolved from NVIDIA's published
 * lookup tables (never hard-coded guesses), and if any step fails to resolve the
 * exact GPU the source reports "manual" and hands the user the official download
 * page instead of inventing a version.
 */

const LOOKUP = 'https://www.nvidia.com/Download/API/lookupValueSearch.aspx'
const MANUAL_LOOKUP = 'https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php'
const OFFICIAL_PAGE = 'https://www.nvidia.com/Download/index.aspx'

const TYPE_SERIES = 2
const TYPE_PRODUCT = 3
const TYPE_OS = 4
const GEFORCE_PARENT = '1'

interface ManualLookupResponse {
  Success?: string
  IDS?: { downloadInfo?: NvidiaDownloadInfo }[]
}

interface NvidiaDownloadInfo {
  ID?: string
  Name?: string
  Version?: string
  ReleaseDateTime?: string
  DownloadURL?: string
  IsWHQL?: string
  IsBeta?: string
  ReleaseNotes?: string
}

interface ResolvedProduct {
  psid: string
  pfid: string
  seriesName: string
  productName: string
}

const RESOLVE_CACHE_KEY = 'nvidia.product.'
const OS_CACHE_KEY = 'nvidia.osid.'

/**
 * Derive NVIDIA's series name from a product name. NVIDIA names series by
 * decade: "GeForce RTX 4060" lives in "GeForce RTX 40 Series", "GeForce GTX
 * 1660 Ti" in "GeForce GTX 16 Series", "GeForce GTX 750" in "GeForce GTX 700
 * Series". Laptop parts sit in the "(Notebooks)" variant.
 */
export function deriveSeriesNames(gpuName: string): string[] {
  const match = /geforce\s+(rtx|gtx|gt|mx)\s*(\d{3,4})/i.exec(gpuName)
  if (!match) return []
  const family = (match[1] ?? '').toUpperCase()
  const digits = match[2] ?? ''
  const prefix = digits.length === 4 ? digits.slice(0, 2) : `${digits.slice(0, 1)}00`
  const base = `GeForce ${family} ${prefix} Series`
  const laptop = /laptop|mobile|max-q/i.test(gpuName)
  return laptop ? [`${base} (Notebooks)`, base] : [base, `${base} (Notebooks)`]
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Windows 11 / 10 identifiers come from NVIDIA's own OS table, not constants. */
async function resolveOsId(osCaption: string, architecture: string): Promise<string | null> {
  const is64 = !architecture || architecture.includes('64')
  const wanted = /windows 11/i.test(osCaption) ? 'windows 11' : 'windows 10 64-bit'
  const cacheKey = `${OS_CACHE_KEY}${wanted}`
  const cachedValue = store.getKv(cacheKey)
  if (cachedValue) return cachedValue

  const xml = await fetchText(`${LOOKUP}?TypeID=${TYPE_OS}`)
  const values = parseLookupValues(xml)
  const target = wanted === 'windows 11' && !is64 ? 'windows 10 32-bit' : wanted
  const hit = values.find((v) => normalise(v.name) === target)
  if (!hit) return null
  store.setKv(cacheKey, hit.value)
  return hit.value
}

async function resolveProduct(gpuName: string): Promise<ResolvedProduct | null> {
  const cacheKey = `${RESOLVE_CACHE_KEY}${normalise(gpuName)}`
  const cachedValue = store.getKv(cacheKey)
  if (cachedValue) {
    try {
      return JSON.parse(cachedValue) as ResolvedProduct
    } catch {
      /* fall through and re-resolve */
    }
  }

  const seriesXml = await fetchText(`${LOOKUP}?TypeID=${TYPE_SERIES}`)
  const allSeries = parseLookupValues(seriesXml).filter((s) => s.parentId === GEFORCE_PARENT)
  const candidates = deriveSeriesNames(gpuName)
    .map((name) => allSeries.find((s) => normalise(s.name) === normalise(name)))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))

  const wantedProduct = normalise(gpuName)
  for (const series of candidates) {
    const productXml = await fetchText(`${LOOKUP}?TypeID=${TYPE_PRODUCT}&ParentID=${series.value}`)
    const products = parseLookupValues(productXml)
    // NVIDIA lists products as "NVIDIA GeForce RTX 4060" — exactly what
    // Win32_VideoController reports — so an exact match is achievable. Accept a
    // suffix match too, since some driver stacks omit the vendor prefix.
    const hit =
      products.find((p) => normalise(p.name) === wantedProduct) ??
      products.find((p) => normalise(p.name) === `nvidia ${wantedProduct}`) ??
      products.find((p) => normalise(p.name).endsWith(wantedProduct))
    if (hit) {
      const resolved: ResolvedProduct = {
        psid: series.value,
        pfid: hit.value,
        seriesName: series.name,
        productName: hit.name
      }
      store.setKv(cacheKey, JSON.stringify(resolved))
      return resolved
    }
  }
  return null
}

function parseReleaseDate(raw: string | undefined): string | null {
  if (!raw) return null
  // NVIDIA formats these as "Tue Jul 28, 2026".
  const time = Date.parse(raw)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/**
 * Decide how strongly to recommend a newer NVIDIA driver.
 *
 * A branch change (610.x → 615.x) is where NVIDIA ships new game support, so
 * that earns a recommendation. A same-branch bump is usually a targeted hotfix
 * and gets classified Optional with an explicit "staying put is fine" note —
 * the app deliberately does not push every release.
 */
export function classifyNvidiaUpdate(
  installed: string | null,
  available: string,
  releaseDate: string | null,
  installedAgeDays: number | null,
  isBeta: boolean,
  deviceHasProblem: boolean
): { classification: UpdateClassification; risk: RiskLevel; rationale: string[] } {
  const rationale: string[] = []

  if (isBeta) {
    return {
      classification: 'experimental',
      risk: 'medium',
      rationale: [
        'NVIDIA publishes this as a beta / non-WHQL driver.',
        'Beta drivers are useful for a specific new title or bug fix, but they receive less validation than Game Ready WHQL releases.'
      ]
    }
  }

  if (deviceHasProblem) {
    return {
      classification: 'critical',
      risk: 'low',
      rationale: [
        'Windows is currently reporting a problem with this display device.',
        'Reinstalling or updating the display driver is the standard first step for a device in an error state.'
      ]
    }
  }

  const installedBranch = installed?.split('.')[0] ?? null
  const availableBranch = available.split('.')[0] ?? null
  const branchChanged = installedBranch !== null && availableBranch !== null && installedBranch !== availableBranch

  if (installedAgeDays !== null && installedAgeDays > 365) {
    rationale.push(`Your installed driver is about ${Math.round(installedAgeDays / 30)} months old.`)
    rationale.push('Drivers this old commonly predate support for recently released games.')
    return { classification: 'critical', risk: 'low', rationale }
  }

  if (branchChanged) {
    rationale.push(`NVIDIA has moved to a new driver branch (${installedBranch}.x → ${availableBranch}.x).`)
    rationale.push('New branches are where NVIDIA adds support and optimisations for newly released games.')
    if (releaseDate) rationale.push(`Published ${new Date(releaseDate).toLocaleDateString()}.`)
    return { classification: 'recommended', risk: 'low', rationale }
  }

  rationale.push(`This is a same-branch update (${installed ?? '?'} → ${available}).`)
  rationale.push('Same-branch releases are normally targeted hotfixes rather than broad gaming improvements.')
  rationale.push('No significant gaming benefit detected — keeping your current driver is reasonable.')
  return { classification: 'optional', risk: 'low', rationale }
}

export const nvidiaSource: DriverSource = {
  id: 'nvidia',
  label: 'Official NVIDIA driver lookup',
  kind: 'vendor-api',

  applicable(ctx: SourceContext): boolean {
    return ctx.allowNetwork && ctx.hardware.gpus.some((gpu) => gpu.vendor === 'nvidia')
  },

  async check(ctx: SourceContext): Promise<SourceResult> {
    const gpus = ctx.hardware.gpus.filter((gpu) => gpu.vendor === 'nvidia')
    const updates: DriverUpdate[] = []
    const notes: string[] = []

    for (const gpu of gpus) {
      if (ctx.signal.aborted) break
      try {
        const result = await checkGpu(gpu, ctx)
        if (result.update) updates.push(result.update)
        notes.push(result.note)
      } catch (error) {
        const message = describeError(error)
        log.warn('nvidia-source', `${gpu.name}: ${message}`)
        notes.push(`${gpu.name}: lookup failed (${message})`)
        updates.push(manualFallback(gpu, `NVIDIA's driver lookup could not be reached (${message}).`))
      }
    }

    return {
      status: {
        id: 'nvidia',
        label: 'Official NVIDIA driver lookup',
        state: notes.length > 0 ? 'ok' : 'skipped',
        detail: notes.join(' · ') || 'No NVIDIA GPU present.'
      },
      updates
    }
  }
}

async function checkGpu(gpu: GpuInfo, ctx: SourceContext): Promise<{ update: DriverUpdate | null; note: string }> {
  const osId = await resolveOsId(ctx.hardware.system.osCaption, ctx.hardware.system.osArchitecture)
  if (!osId) {
    return {
      update: manualFallback(gpu, 'NVIDIA does not publish a driver list for this Windows edition through the lookup service.'),
      note: `${gpu.name}: operating system not in NVIDIA's lookup table`
    }
  }

  const product = await resolveProduct(gpu.name)
  if (!product) {
    return {
      update: manualFallback(
        gpu,
        `This GPU model could not be matched against NVIDIA's published product list, so GameDriver Pro will not guess a version for it.`
      ),
      note: `${gpu.name}: not matched in NVIDIA product list`
    }
  }

  const params = new URLSearchParams({
    func: 'DriverManualLookup',
    psid: product.psid,
    pfid: product.pfid,
    osID: osId,
    languageCode: '1033',
    isWHQL: '1',
    dch: '1',
    sort1: '0',
    numberOfResults: '1'
  })
  const response = await fetchJson<ManualLookupResponse>(`${MANUAL_LOOKUP}?${params.toString()}`, 20_000)
  const info = response.IDS?.[0]?.downloadInfo
  if (response.Success !== '1' && !info?.Version) {
    return {
      update: manualFallback(gpu, 'NVIDIA returned no driver for this GPU and operating system combination.'),
      note: `${gpu.name}: no driver returned`
    }
  }

  const available = (info?.Version ?? '').trim()
  const installed = gpu.displayDriverVersion
  const comparison = compareVersions(installed, available)

  if (!available) {
    return {
      update: manualFallback(gpu, 'NVIDIA returned a driver entry without a version number.'),
      note: `${gpu.name}: version missing from response`
    }
  }

  if (comparison !== null && comparison >= 0) {
    return { update: null, note: `${gpu.name}: up to date (${installed} · latest ${available})` }
  }

  const releaseDate = parseReleaseDate(info?.ReleaseDateTime)
  const isBeta = info?.IsBeta === '1'
  const deviceHasProblem = gpu.status === 'error'
  const { classification, risk, rationale } = classifyNvidiaUpdate(
    installed,
    available,
    releaseDate,
    driverAgeDays(gpu.driverDate),
    isBeta,
    deviceHasProblem
  )

  if (comparison === null) {
    rationale.unshift(
      `GameDriver Pro could not reliably compare your installed version (${installed ?? 'unknown'}) with ${available}, so this is shown for information rather than as a confirmed upgrade.`
    )
  }

  const downloadUrl = info?.DownloadURL ?? null
  const name = info?.Name ? decodeURIComponent(info.Name.replace(/\+/g, ' ')) : 'NVIDIA Display Driver'

  // Only offer to install it ourselves when NVIDIA handed us a URL on their own
  // distribution domain. Anything else stays a hand-off to their download page.
  const officialDownload = downloadUrl !== null && isAllowedHost(downloadUrl)

  return {
    note: `${gpu.name}: ${installed ?? 'unknown'} → ${available}`,
    update: {
      id: `nvidia:${gpu.id}:${available}`,
      deviceName: gpu.name,
      category: 'graphics',
      currentVersion: installed,
      availableVersion: available,
      releaseDate,
      source: {
        id: 'nvidia',
        label: `Official NVIDIA · ${name}`,
        official: true,
        url: downloadUrl ?? OFFICIAL_PAGE,
        kind: 'vendor-api'
      },
      classification: comparison === null ? 'unknown' : classification,
      risk,
      rationale,
      action: officialDownload ? 'vendor-install' : 'manual',
      catalog: null,
      download: officialDownload
        ? {
            url: downloadUrl,
            // The downloaded file must carry NVIDIA's own Authenticode
            // signature before the app will run it.
            expectedSigner: 'NVIDIA Corporation',
            // NVIDIA's documented installer switches.
            silentArgs: ['-s', '-noreboot'],
            cleanArgs: ['-clean'],
            installerName: name
          }
        : null,
      sizeBytes: null,
      updateIdentity: null,
      verified: officialDownload,
      verificationNote: officialDownload
        ? 'Served from NVIDIA’s own distribution host, and the file’s signature is checked against “NVIDIA Corporation” before it is allowed to run.'
        : 'Download link could not be confirmed as an official NVIDIA host — open NVIDIA’s driver page instead.'
    }
  }
}

function manualFallback(gpu: GpuInfo, reason: string): DriverUpdate {
  return {
    id: `nvidia-manual:${gpu.id}`,
    deviceName: gpu.name,
    category: 'graphics',
    currentVersion: gpu.displayDriverVersion ?? gpu.driverVersion,
    availableVersion: null,
    releaseDate: null,
    source: {
      id: 'nvidia',
      label: 'Official NVIDIA driver page',
      official: true,
      url: OFFICIAL_PAGE,
      kind: 'vendor-page'
    },
    classification: 'unknown',
    risk: 'unknown',
    rationale: [reason, 'Check NVIDIA’s official driver page manually to confirm the current version for this GPU.'],
    action: 'manual',
    download: null,
    catalog: null,
    sizeBytes: null,
    updateIdentity: null,
    verified: true,
    verificationNote: 'Links to NVIDIA’s own driver download page.'
  }
}
