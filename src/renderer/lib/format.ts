/**
 * Formatting helpers.
 *
 * The rule that matters here: a null value means the system did not report it,
 * and it renders as an em dash — never as 0, "N/A" glued into a number, or a
 * plausible-looking placeholder.
 */

export const DASH = '—'

export function bytes(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  if (value === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const exponent = Math.min(Math.floor(Math.log(Math.abs(value)) / Math.log(1024)), units.length - 1)
  const scaled = value / 1024 ** exponent
  const decimals = exponent <= 1 ? 0 : scaled >= 100 ? 0 : digits
  return `${scaled.toFixed(decimals)} ${units[exponent]}`
}

export function gigabytes(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  return `${(value / 1024 ** 3).toFixed(digits)} GB`
}

export function bitsPerSecond(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return DASH
  const bits = bytesPerSecond * 8
  if (bits < 1000) return `${Math.round(bits)} bps`
  if (bits < 1_000_000) return `${(bits / 1000).toFixed(0)} Kbps`
  if (bits < 1_000_000_000) return `${(bits / 1_000_000).toFixed(1)} Mbps`
  return `${(bits / 1_000_000_000).toFixed(2)} Gbps`
}

export function linkSpeed(bitsPerSecondValue: number | null | undefined): string {
  if (bitsPerSecondValue === null || bitsPerSecondValue === undefined || bitsPerSecondValue <= 0) return DASH
  if (bitsPerSecondValue >= 1_000_000_000) return `${(bitsPerSecondValue / 1_000_000_000).toFixed(1)} Gb/s`
  return `${Math.round(bitsPerSecondValue / 1_000_000)} Mb/s`
}

export function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  return `${value.toFixed(digits)}%`
}

export function number(value: number | null | undefined, digits = 0, suffix = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  return `${value.toFixed(digits)}${suffix}`
}

export function temperature(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  return `${Math.round(value)}°C`
}

export function megahertz(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  if (value >= 1000) return `${(value / 1000).toFixed(2)} GHz`
  return `${Math.round(value)} MHz`
}

export function watts(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  return `${value.toFixed(0)} W`
}

export function date(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return DASH
  const time = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(time)) return DASH
  return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function dateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return DASH
  const time = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(time)) return DASH
  return new Date(time).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function relative(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  const seconds = Math.round((Date.now() - value) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`
  return date(value)
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function text(value: string | null | undefined): string {
  return value === null || value === undefined || value.trim() === '' ? DASH : value.trim()
}

export function initials(name: string): string {
  const words = name.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase()
  return `${(words[0] ?? '')[0] ?? ''}${(words[1] ?? '')[0] ?? ''}`.toUpperCase()
}

export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** Convert an absolute local artwork path into the sandboxed art protocol URL. */
export function artUrl(path: string | null): string | null {
  if (!path) return null
  return `gdp-art://local/${encodeURIComponent(path)}`
}
