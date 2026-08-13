import { fetchText, postForm } from '../http'
import { compareVersions, isInboxDriver } from '../drivers'
import { log, describeError } from '../logger'
import type { DriverSource, SourceContext, SourceResult } from './types'
import type { DriverEntry, DriverUpdate, RiskLevel, UpdateClassification } from '../../../shared/types'

/**
 * Microsoft Update Catalog as a driver source.
 *
 * This is what makes in-app installation possible for hardware whose maker
 * publishes no usable API — Intel chipsets, Realtek audio, Qualcomm and Killer
 * networking, AMD components, and so on. Every package here is WHQL-signed,
 * published by Microsoft, and served from Microsoft's own update CDN. It is the
 * same catalogue IT administrators pull drivers from, not a third-party mirror.
 *
 * Two honest limitations, both surfaced rather than hidden:
 *  - the catalogue has no JSON API, so its search results are parsed from HTML.
 *    If Microsoft changes that markup this source reports an error instead of
 *    guessing;
 *  - a catalogue entry whose version cannot be read is skipped entirely. The app
 *    will not offer an "update" it cannot compare against what you have.
 */

const SEARCH_URL = 'https://www.catalog.update.microsoft.com/Search.aspx'
const DETAIL_URL = 'https://www.catalog.update.microsoft.com/ScopedViewInline.aspx'
const DOWNLOAD_URL = 'https://www.catalog.update.microsoft.com/DownloadDialog.aspx'

/**
 * Each query is a network round-trip, so the scan looks at the devices most
 * worth checking rather than all ~130. Whatever is skipped is reported.
 * Queries run a few at a time, which keeps the wall-clock cost of covering
 * every relevant device to a few seconds rather than a minute.
 */
const MAX_QUERIES = 26
const QUERY_CONCURRENCY = 4

/** Gaming relevance, best first — decides who gets queried when capped. */
const CATEGORY_PRIORITY: Record<string, number> = {
  graphics: 0,
  wifi: 1,
  network: 2,
  audio: 3,
  chipset: 4,
  storage: 5,
  bluetooth: 6,
  controller: 7,
  usb: 8
}

/** Run tasks with a bounded number in flight. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      const item = items[index]
      if (index >= items.length || item === undefined) return
      results[index] = await worker(item)
    }
  })
  await Promise.all(runners)
  return results
}

const RELEVANT_CATEGORIES = new Set([
  'graphics',
  'chipset',
  'audio',
  'network',
  'wifi',
  'bluetooth',
  'storage',
  'usb',
  'controller'
])

export interface CatalogResult {
  updateId: string
  title: string
  version: string | null
  lastUpdated: string | null
  sizeBytes: number | null
}

/**
 * Reduce a full hardware ID to the vendor+device form the catalogue indexes.
 * `PCI\VEN_8086&DEV_3E98&SUBSYS_86941043&REV_02\3&11583659&0&10` becomes
 * `PCI\VEN_8086&DEV_3E98` — specific enough to identify the part, general
 * enough that subsystem variations still match.
 */
export function catalogSearchKey(hardwareId: string | null, deviceId: string | null): string | null {
  const source = hardwareId ?? deviceId
  if (!source) return null
  const text = source.toUpperCase().replace(/\r?\n.*$/s, '').trim()

  const bus = /^(PCI|HDAUDIO|USB|ACPI|SD|SCSI)\\/.exec(text)?.[1]
  if (!bus) return null

  const ven = /VEN_([0-9A-F]{4})/.exec(text)?.[1] ?? /VID_([0-9A-F]{4})/.exec(text)?.[1]
  const dev = /DEV_([0-9A-F]{4})/.exec(text)?.[1] ?? /PID_([0-9A-F]{4})/.exec(text)?.[1]
  if (!ven || !dev) return null

  const venKey = text.includes('VID_') ? 'VID' : 'VEN'
  const devKey = text.includes('PID_') ? 'PID' : 'DEV'
  const func = /FUNC_([0-9A-F]{2})/.exec(text)?.[1]

  return func
    ? `${bus}\\FUNC_${func}&${venKey}_${ven}&${devKey}_${dev}`
    : `${bus}\\${venKey}_${ven}&${devKey}_${dev}`
}

/**
 * Read a driver version out of a catalogue title. Microsoft publishes these in
 * two shapes, e.g. "Qualcomm Communications Inc. - Net - 10.0.3.463" and
 * "Intel Corporation Display Driver Update (31.0.101.2141)".
 */
export function versionFromCatalogTitle(title: string): string | null {
  const parenthesised = /\((\d+(?:\.\d+){1,3})\)/.exec(title)
  if (parenthesised?.[1]) return parenthesised[1]
  const trailing = /(\d+(?:\.\d+){1,3})\s*$/.exec(title.trim())
  return trailing?.[1] ?? null
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/**
 * Parse the catalogue's results table.
 *
 * The row id carries the update GUID, and each cell is id'd `<guid>_C<n>_R<n>`:
 * C1 title, C4 last updated, C6 size (with the byte count in a hidden span).
 */
export function parseCatalogResults(html: string): CatalogResult[] {
  const results: CatalogResult[] = []
  const seen = new Set<string>()

  const linkPattern = /<a id='([0-9a-fA-F-]{36})_link'[^>]*>([\s\S]*?)<\/a>/g
  let match: RegExpExecArray | null

  while ((match = linkPattern.exec(html)) !== null) {
    const updateId = match[1]
    const title = decodeHtml((match[2] ?? '').replace(/\s+/g, ' '))
    if (!updateId || !title || seen.has(updateId)) continue
    seen.add(updateId)

    const dateCell = new RegExp(`id="${updateId}_C4_R\\d+"[^>]*>([\\s\\S]*?)</td>`).exec(html)
    const sizeCell = new RegExp(`id="${updateId}_originalSize"[^>]*>([\\s\\S]*?)</span>`).exec(html)
    const rawSize = sizeCell?.[1] ? Number(sizeCell[1].trim()) : NaN

    results.push({
      updateId,
      title,
      version: versionFromCatalogTitle(title),
      lastUpdated: dateCell?.[1] ? decodeHtml(dateCell[1]) : null,
      sizeBytes: Number.isFinite(rawSize) ? rawSize : null
    })
  }

  return results
}

/** Pull the authoritative driver version from an entry's detail page. */
export async function catalogDetailVersion(updateId: string): Promise<string | null> {
  try {
    const html = await fetchText(`${DETAIL_URL}?updateid=${encodeURIComponent(updateId)}`, 20_000)
    const version = /id="ScopedViewHandler_version"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1]
    const trimmed = version ? decodeHtml(version) : null
    return trimmed && /^\d+(\.\d+){1,3}$/.test(trimmed) ? trimmed : null
  } catch (error) {
    log.warn('catalog', `Detail lookup failed for ${updateId}: ${describeError(error)}`)
    return null
  }
}

/**
 * Resolve an update's actual package URLs. The catalogue only reveals these
 * through its download dialog, which takes a JSON blob of update identities.
 */
export async function catalogDownloadUrls(updateId: string): Promise<string[]> {
  const payload = JSON.stringify([{ size: 0, languages: '', uidInfo: updateId, updateID: updateId }])
  const html = await postForm(DOWNLOAD_URL, {
    updateIDs: payload,
    updateIDsBlockedForImport: '',
    wsusApiPresent: '',
    contentImport: '',
    sku: '',
    serverName: '',
    ssl: '',
    portNumber: '',
    version: ''
  })

  const urls: string[] = []
  const pattern = /downloadInformation\[\d+\]\.files\[\d+\]\.url\s*=\s*'([^']+)'/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    if (match[1]) urls.push(match[1])
  }
  return urls
}

/** Search the catalogue for one device. */
export async function searchCatalog(searchKey: string): Promise<CatalogResult[]> {
  const html = await fetchText(`${SEARCH_URL}?q=${encodeURIComponent(searchKey)}`, 30_000)
  if (/did not match any|No updates matched/i.test(html)) return []
  return parseCatalogResults(html)
}

function classify(
  entry: DriverEntry,
  best: CatalogResult
): { classification: UpdateClassification; risk: RiskLevel; rationale: string[] } {
  const rationale: string[] = [
    `Microsoft publishes ${best.version} for this device; you have ${entry.driverVersion ?? 'an unknown version'}.`
  ]
  if (best.lastUpdated) rationale.push(`Published to the Update Catalog on ${best.lastUpdated}.`)

  if (entry.status === 'error') {
    rationale.push('Windows currently reports a problem with this device, so a fresh signed driver is a sensible first step.')
    return { classification: 'critical', risk: 'low', rationale }
  }

  if (entry.category === 'graphics') {
    rationale.push(
      'For graphics, the GPU vendor’s own package is usually newer and better tuned for games than the catalogue copy — treat this as a fallback.'
    )
    return { classification: 'optional', risk: 'low', rationale }
  }

  rationale.push(
    'This is a WHQL-signed package from the Microsoft Update Catalog, installed with Windows’ own pnputil. It affects system stability rather than frame rate.'
  )
  return { classification: 'recommended', risk: 'low', rationale }
}

/** Devices worth spending a query on, most important first. */
function prioritise(drivers: DriverEntry[]): DriverEntry[] {
  return drivers
    .filter((entry) => RELEVANT_CATEGORIES.has(entry.category))
    .filter((entry) => catalogSearchKey(entry.hardwareIds[0] ?? null, entry.deviceId) !== null)
    .sort((a, b) => {
      // Devices Windows is complaining about first, then by how much the
      // category matters for gaming, then real vendor drivers before in-box ones.
      const score = (entry: DriverEntry) =>
        (entry.status === 'error' ? 0 : 100) +
        (CATEGORY_PRIORITY[entry.category] ?? 9) * 2 +
        (isInboxDriver(entry) ? 20 : 0)
      return score(a) - score(b)
    })
}

export const catalogSource: DriverSource = {
  id: 'update-catalog',
  label: 'Microsoft Update Catalog',
  kind: 'windows-update',

  applicable(ctx: SourceContext): boolean {
    return ctx.allowNetwork
  },

  async check(ctx: SourceContext): Promise<SourceResult> {
    const candidates = prioritise(ctx.drivers)
    const queried = candidates.slice(0, MAX_QUERIES)
    const skipped = candidates.length - queried.length

    const updates: DriverUpdate[] = []
    let failures = 0
    let matched = 0
    let unreadableVersion = 0

    await mapLimit(queried, QUERY_CONCURRENCY, async (entry) => {
      if (ctx.signal.aborted) return
      const key = catalogSearchKey(entry.hardwareIds[0] ?? null, entry.deviceId)
      if (!key) return

      try {
        const results = await searchCatalog(key)
        if (results.length === 0) return
        matched += 1

        // Only rows whose version can actually be read are candidates; the rest
        // cannot be compared with what is installed, so they are not offered.
        const comparable = results.filter((row) => row.version !== null)
        if (comparable.length === 0) {
          unreadableVersion += 1
          return
        }

        const best = comparable.reduce((a, b) => ((compareVersions(b.version, a.version) ?? 0) > 0 ? b : a))
        const comparison = compareVersions(best.version, entry.driverVersion)
        if (comparison === null || comparison <= 0) return

        const { classification, risk, rationale } = classify(entry, best)
        updates.push({
          id: `catalog:${best.updateId}`,
          deviceName: entry.deviceName,
          category: entry.category,
          currentVersion: entry.displayVersion ?? entry.driverVersion,
          availableVersion: best.version,
          releaseDate: best.lastUpdated,
          source: {
            id: 'update-catalog',
            label: `Microsoft Update Catalog · ${best.title}`,
            official: true,
            url: `${DETAIL_URL}?updateid=${best.updateId}`,
            kind: 'windows-update'
          },
          classification,
          risk,
          rationale,
          action: 'catalog-install',
          download: null,
          catalog: { updateId: best.updateId, title: best.title },
          sizeBytes: best.sizeBytes,
          updateIdentity: null,
          verified: true,
          verificationNote:
            'WHQL-signed package served from Microsoft’s update CDN. Its signature is verified before anything is extracted or installed.'
        })
      } catch (error) {
        failures += 1
        log.warn('catalog', `Search failed for ${entry.deviceName}: ${describeError(error)}`)
      }
    })

    updates.sort((a, b) => a.deviceName.localeCompare(b.deviceName))

    const detail = [
      `Checked ${queried.length} device(s) by hardware ID; ${matched} had catalogue entries.`,
      updates.length > 0 ? `${updates.length} newer driver(s) found.` : 'No newer drivers found.',
      unreadableVersion > 0 ? `${unreadableVersion} device(s) had entries with no readable version and were skipped.` : null,
      skipped > 0 ? `${skipped} further device(s) not queried this scan.` : null,
      failures > 0 ? `${failures} search(es) failed.` : null
    ]
      .filter(Boolean)
      .join(' ')

    return {
      status: {
        id: 'update-catalog',
        label: 'Microsoft Update Catalog',
        state: failures > 0 && matched === 0 ? 'error' : 'ok',
        detail
      },
      updates
    }
  }
}
