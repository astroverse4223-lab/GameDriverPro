import { log, describeError } from './logger'

/**
 * Outbound HTTP for the vendor driver-lookup adapters.
 *
 * Only hosts on this allow-list can ever be contacted, and only over HTTPS.
 * Nothing about the machine is transmitted beyond the vendor's own product and
 * OS identifiers required to answer "what is the current driver for this GPU?".
 */
const ALLOWED_HOSTS = new Set([
  'www.nvidia.com',
  'gfwsl.geforce.com',
  'us.download.nvidia.com',
  'www.amd.com',
  'www.intel.com'
])

const USER_AGENT = 'GameDriverPro/0.1 (+local driver manager)'

export class HttpError extends Error {}

export function isAllowedHost(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

export async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  if (!isAllowedHost(url)) {
    throw new HttpError(`Refusing to contact a host that is not an approved official source: ${url}`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/xml, text/plain, */*' }
    })
    if (!response.ok) throw new HttpError(`${response.status} ${response.statusText}`)
    return await response.text()
  } catch (error) {
    log.warn('http', `GET ${url} failed: ${describeError(error)}`)
    throw error instanceof HttpError ? error : new HttpError(describeError(error))
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const text = await fetchText(url, timeoutMs)
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new HttpError(`Vendor endpoint returned malformed JSON: ${describeError(error)}`)
  }
}

/** Minimal attribute/element reader for the small XML documents NVIDIA serves. */
export function parseLookupValues(xml: string): { name: string; value: string; parentId: string | null }[] {
  const results: { name: string; value: string; parentId: string | null }[] = []
  const blocks = xml.match(/<LookupValue\b[^>]*>[\s\S]*?<\/LookupValue>/g) ?? []
  for (const block of blocks) {
    const name = /<Name>([\s\S]*?)<\/Name>/.exec(block)?.[1]
    const value = /<Value>([\s\S]*?)<\/Value>/.exec(block)?.[1]
    const parentId = /ParentID="([^"]*)"/.exec(block)?.[1] ?? null
    if (name && value) {
      results.push({ name: decodeXml(name.trim()), value: value.trim(), parentId })
    }
  }
  return results
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}
