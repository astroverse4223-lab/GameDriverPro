import { driverAgeDays, isInboxDriver } from '../drivers'
import type { DriverSource, SourceContext, SourceResult } from './types'
import type { DriverCategory, DriverEntry, DriverUpdate } from '../../../shared/types'

/**
 * Official manufacturer download pages.
 *
 * AMD, Intel, Realtek and the board vendors do not publish a stable public API
 * for "latest driver version", and this app will not scrape third-party driver
 * sites to fake one. So for those devices GameDriver Pro does the honest thing:
 * it identifies the device precisely and links to the manufacturer's own
 * download page, without claiming to know that a newer version exists.
 *
 * `sources.json`-style extension: add an entry here (or ship one via settings)
 * to teach the app a new official source.
 */

export interface VendorPage {
  id: string
  label: string
  url: string
  /** Matched against driver provider / manufacturer / device name. */
  match: RegExp
  categories: DriverCategory[]
}

export const VENDOR_PAGES: VendorPage[] = [
  {
    id: 'amd-graphics',
    label: 'AMD Drivers and Support',
    url: 'https://www.amd.com/en/support',
    match: /\b(amd|advanced micro devices|ati)\b/i,
    categories: ['graphics', 'chipset', 'audio']
  },
  {
    id: 'intel-graphics',
    label: 'Intel Download Center',
    url: 'https://www.intel.com/content/www/us/en/download-center/home.html',
    match: /\bintel\b/i,
    categories: ['graphics', 'chipset', 'network', 'wifi', 'bluetooth', 'storage']
  },
  {
    id: 'realtek',
    label: 'Realtek downloads (via your board manufacturer)',
    url: 'https://www.realtek.com/Download',
    match: /realtek/i,
    categories: ['audio', 'network', 'bluetooth']
  },
  {
    id: 'nvidia-page',
    label: 'NVIDIA Driver Downloads',
    url: 'https://www.nvidia.com/Download/index.aspx',
    match: /nvidia/i,
    categories: ['graphics', 'audio']
  },
  {
    id: 'asus',
    label: 'ASUS Support',
    url: 'https://www.asus.com/support/download-center/',
    match: /asus|asustek/i,
    categories: ['chipset', 'motherboard', 'audio', 'network', 'wifi', 'bluetooth']
  },
  {
    id: 'msi',
    label: 'MSI Support',
    url: 'https://www.msi.com/support/download',
    match: /\bmsi\b|micro-star/i,
    categories: ['chipset', 'motherboard', 'audio', 'network', 'wifi', 'bluetooth']
  },
  {
    id: 'gigabyte',
    label: 'GIGABYTE Support',
    url: 'https://www.gigabyte.com/Support',
    match: /gigabyte|giga-byte/i,
    categories: ['chipset', 'motherboard', 'audio', 'network', 'wifi', 'bluetooth']
  },
  {
    id: 'asrock',
    label: 'ASRock Support',
    url: 'https://www.asrock.com/support/index.asp',
    match: /asrock/i,
    categories: ['chipset', 'motherboard', 'audio', 'network', 'wifi', 'bluetooth']
  },
  {
    id: 'dell',
    label: 'Dell Drivers & Downloads',
    url: 'https://www.dell.com/support/home/en-us?app=drivers',
    match: /\bdell\b|alienware/i,
    categories: ['chipset', 'motherboard', 'audio', 'network', 'wifi', 'bluetooth', 'graphics', 'storage']
  },
  {
    id: 'hp',
    label: 'HP Software and Driver Downloads',
    url: 'https://support.hp.com/us-en/drivers',
    match: /hewlett|hp inc|\bhp\b|omen/i,
    categories: ['chipset', 'motherboard', 'audio', 'network', 'wifi', 'bluetooth', 'graphics', 'storage']
  },
  {
    id: 'lenovo',
    label: 'Lenovo Support',
    url: 'https://support.lenovo.com/us/en/',
    match: /lenovo|thinkpad|legion/i,
    categories: ['chipset', 'motherboard', 'audio', 'network', 'wifi', 'bluetooth', 'graphics', 'storage']
  },
  {
    id: 'acer',
    label: 'Acer Drivers and Manuals',
    url: 'https://www.acer.com/us-en/support/drivers-and-manuals',
    match: /acer|predator|nitro/i,
    categories: ['chipset', 'motherboard', 'audio', 'network', 'wifi', 'bluetooth', 'graphics', 'storage']
  },
  {
    id: 'microsoft',
    label: 'Microsoft Update Catalog',
    url: 'https://www.catalog.update.microsoft.com/Home.aspx',
    match: /microsoft/i,
    categories: ['audio', 'network', 'bluetooth', 'usb', 'storage', 'input', 'controller', 'system', 'chipset']
  },
  {
    id: 'qualcomm',
    label: 'Qualcomm Atheros drivers (via your board or laptop manufacturer)',
    url: 'https://www.qualcomm.com/support',
    match: /qualcomm|atheros|killer/i,
    categories: ['network', 'wifi', 'bluetooth']
  },
  {
    id: 'mediatek',
    label: 'MediaTek support (via your board or laptop manufacturer)',
    url: 'https://www.mediatek.com/about/contact-us',
    match: /mediatek|\bmtk\b/i,
    categories: ['network', 'wifi', 'bluetooth']
  }
]

/**
 * Age past which a vendor driver is worth a look, in days.
 *
 * This threshold is only ever applied to third-party drivers with a credible
 * date. Windows' own in-box drivers are excluded entirely: they all carry the
 * same 2006 placeholder date and are serviced by Windows Update, so flagging
 * them would manufacture dozens of fake "worth checking" items — precisely the
 * behaviour this app exists to avoid.
 */
const STALE_DAYS = 900

/** Never suggest manual follow-up for more devices than a person would act on. */
const MAX_SUGGESTIONS = 8

export function findVendorPage(entry: DriverEntry): VendorPage | null {
  const haystack = `${entry.driverProvider ?? ''} ${entry.manufacturer ?? ''} ${entry.deviceName}`
  return (
    VENDOR_PAGES.find((page) => page.categories.includes(entry.category) && page.match.test(haystack)) ??
    VENDOR_PAGES.find((page) => page.match.test(haystack)) ??
    null
  )
}

/**
 * The board or laptop maker is a sensible fallback for parts they actually
 * distribute drivers for — chipset, on-board audio, on-board networking. It is
 * not a sensible fallback for, say, a VPN tunnel adapter, and attributing one to
 * them would send the user to a page that has never heard of the device.
 */
const BOARD_VENDOR_CATEGORIES = new Set(['chipset', 'motherboard', 'audio'])

/** Software-only devices have no manufacturer download page to point at. */
function isSoftwareDevice(entry: DriverEntry): boolean {
  const id = (entry.deviceId ?? '').toUpperCase()
  return id.startsWith('SWD\\') || id.startsWith('ROOT\\') || id.startsWith('SW\\')
}

export const vendorPageSource: DriverSource = {
  id: 'vendor-pages',
  label: 'Official manufacturer download pages',
  kind: 'vendor-page',

  applicable(): boolean {
    return true
  },

  async check(ctx: SourceContext): Promise<SourceResult> {
    const updates: DriverUpdate[] = []
    const boardVendor = `${ctx.hardware.motherboard.manufacturer ?? ''} ${ctx.hardware.system.manufacturer ?? ''}`
    let inboxSkipped = 0

    for (const entry of ctx.drivers) {
      const hasProblem = entry.status === 'error' || entry.problemCode !== null
      const age = driverAgeDays(entry.driverDate)
      const stale = age !== null && age > STALE_DAYS

      // NVIDIA GPUs are covered by the live vendor API source; do not duplicate.
      if (entry.category === 'graphics' && /nvidia/i.test(entry.driverProvider ?? '')) continue
      if (!['graphics', 'chipset', 'audio', 'network', 'wifi', 'bluetooth', 'storage', 'controller'].includes(entry.category)) {
        continue
      }
      // A working in-box driver is not something to chase a manufacturer about.
      if (!hasProblem && isInboxDriver(entry)) {
        if (stale) inboxSkipped += 1
        continue
      }
      if (!hasProblem && !stale) continue
      if (!hasProblem && isSoftwareDevice(entry)) continue

      const boardFallback = BOARD_VENDOR_CATEGORIES.has(entry.category)
        ? (VENDOR_PAGES.find((p) => p.match.test(boardVendor)) ?? null)
        : null
      const page = findVendorPage(entry) ?? boardFallback
      const rationale: string[] = []

      if (hasProblem) {
        rationale.push(entry.problemText ?? 'Windows is reporting a problem with this device.')
        rationale.push('A device in an error state usually needs its driver reinstalled from the manufacturer.')
      }
      if (stale && age !== null) {
        rationale.push(`The installed driver dates from ${new Date(entry.driverDate ?? '').toLocaleDateString()} (about ${Math.round(age / 365)} years ago).`)
      }
      rationale.push(
        page
          ? `GameDriver Pro cannot query ${page.label} automatically, so it will not claim a newer version exists. Open the official page to check.`
          : 'No official source is configured for this manufacturer, so no version claim is made.'
      )

      updates.push({
        id: `vendor:${entry.id}`,
        deviceName: entry.deviceName,
        category: entry.category,
        currentVersion: entry.displayVersion ?? entry.driverVersion,
        availableVersion: null,
        releaseDate: null,
        source: {
          id: page?.id ?? 'unconfigured',
          label: page?.label ?? 'No official source configured',
          official: true,
          url: page?.url ?? null,
          kind: 'vendor-page'
        },
        classification: hasProblem ? 'critical' : 'unknown',
        risk: hasProblem ? 'low' : 'unknown',
        rationale,
        action: 'manual',
        download: null,
        sizeBytes: null,
        updateIdentity: null,
        verified: page !== null,
        verificationNote: page
          ? 'Link points at the manufacturer’s own support site.'
          : 'No verified official source is configured for this device.'
      })
    }

    // Problems first, then the oldest vendor drivers. Truncation is reported in
    // the status text rather than hidden — a silent cap would read as "that's
    // everything".
    const ranked = updates.sort((a, b) => {
      const aProblem = a.classification === 'critical' ? 0 : 1
      const bProblem = b.classification === 'critical' ? 0 : 1
      return aProblem - bProblem
    })
    const shown = ranked.slice(0, MAX_SUGGESTIONS)
    const truncated = ranked.length - shown.length

    const detail = [
      shown.length === 0
        ? 'No devices need manual manufacturer follow-up.'
        : `${shown.length} device(s) worth checking on the manufacturer’s official page.`,
      truncated > 0 ? `${truncated} further device(s) not shown.` : null,
      inboxSkipped > 0
        ? `${inboxSkipped} Windows in-box driver(s) skipped — Windows dates all of those 2006 regardless of age and services them itself.`
        : null
    ]
      .filter(Boolean)
      .join(' ')

    return {
      status: { id: 'vendor-pages', label: 'Official manufacturer download pages', state: 'ok', detail },
      updates: shown
    }
  }
}
