import { open } from 'node:fs/promises'
import { queryEmitted } from './powershell'
import { CRASH_SCRIPT } from './wmiScripts'
import { log, describeError } from './logger'
import type { CrashAnalysis, CrashEvent, CrashGroup, CrashKind, MemoryDumpInfo } from '../../shared/types'

/**
 * Crash analysis from Windows' own records: the System and Application event
 * logs, plus any kernel crash dumps on disk.
 *
 * Findings are stated as correlations, never as diagnoses. "7 display driver
 * timeouts in 30 days, all naming nvlddmkm" is a fact; "your GPU driver is
 * broken" is a guess, so the app does not say it.
 */

interface RawCrashResponse {
  events: RawEvent[] | RawEvent | null
  dumps: RawDump[] | RawDump | null
  errors: string[] | null
}

interface RawEvent {
  recordId: string
  timestamp: string | null
  provider: string
  eventId: number
  level: number
  logName: string
  message: string
}

interface RawDump {
  path: string
  size: number
  modified: string | null
  kind: 'minidump' | 'kernel'
}

function arr<T>(value: T[] | T | null | undefined): T[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** Windows event levels: 1 critical, 2 error, 3 warning, 4 information. */
function levelOf(level: number): CrashEvent['level'] {
  if (level === 1) return 'critical'
  if (level === 2) return 'error'
  if (level === 3) return 'warning'
  return 'info'
}

function kindOf(raw: RawEvent): CrashKind {
  const provider = raw.provider.toLowerCase()
  if (provider === 'display' || raw.eventId === 4101) return 'display-driver-timeout'
  if (provider === 'bugcheck' || raw.eventId === 1001) return 'bugcheck'
  if (provider === 'microsoft-windows-kernel-power' && raw.eventId === 41) return 'unexpected-shutdown'
  if (provider === 'application error' || provider === 'application hang') return 'app-crash'
  if (provider === 'service control manager') return 'driver-error'
  return 'other'
}

/** Pull the module Windows itself named out of the event text. */
export function moduleFromMessage(message: string): string | null {
  const faulting = /Faulting module name:\s*([^\s,]+)/i.exec(message)
  if (faulting?.[1]) return faulting[1]
  const display = /Display driver\s+([A-Za-z0-9_.-]+)\s+stopped responding/i.exec(message)
  if (display?.[1]) return display[1]
  // Service Control Manager names the service, not a module. Capturing it keeps
  // dozens of unrelated service failures from collapsing into one useless group.
  // The three shapes SCM actually emits (events 7000/7009/7011):
  const service =
    /^The (.{2,80}?) service (?:failed|terminated|hung|depends|was)/im.exec(message) ??
    /while waiting for the (.{2,80}?) service to connect/i.exec(message) ??
    /transaction response from the (.{2,80}?) service/i.exec(message)
  if (service?.[1]) return service[1].trim()
  const driver = /\b([a-z0-9_]{3,}\.sys)\b/i.exec(message)
  if (driver?.[1]) return driver[1]
  return null
}

/** Extract the stop code Windows recorded in a BugCheck event. */
export function stopCodeFromMessage(message: string): string | null {
  const match = /bugcheck was:\s*(0x[0-9a-f]+)/i.exec(message) ?? /\b(0x[0-9a-f]{8})\b/i.exec(message)
  return match?.[1]?.toLowerCase() ?? null
}

const STOP_CODE_NAMES: Record<number, string> = {
  0x0a: 'IRQL_NOT_LESS_OR_EQUAL',
  0x1a: 'MEMORY_MANAGEMENT',
  0x1e: 'KMODE_EXCEPTION_NOT_HANDLED',
  0x3b: 'SYSTEM_SERVICE_EXCEPTION',
  0x50: 'PAGE_FAULT_IN_NONPAGED_AREA',
  0x7e: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED',
  0x7f: 'UNEXPECTED_KERNEL_MODE_TRAP',
  0x9f: 'DRIVER_POWER_STATE_FAILURE',
  0xc2: 'BAD_POOL_CALLER',
  0xc4: 'DRIVER_VERIFIER_DETECTED_VIOLATION',
  0xc5: 'DRIVER_CORRUPTED_EXPOOL',
  0xd1: 'DRIVER_IRQL_NOT_LESS_OR_EQUAL',
  0xef: 'CRITICAL_PROCESS_DIED',
  0x109: 'CRITICAL_STRUCTURE_CORRUPTION',
  0x116: 'VIDEO_TDR_ERROR',
  0x117: 'VIDEO_TDR_TIMEOUT_DETECTED',
  0x119: 'VIDEO_SCHEDULER_INTERNAL_ERROR',
  0x124: 'WHEA_UNCORRECTABLE_ERROR',
  0x133: 'DPC_WATCHDOG_VIOLATION',
  0x139: 'KERNEL_SECURITY_CHECK_FAILURE',
  0x1000007e: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED_M',
  0x0000009c: 'MACHINE_CHECK_EXCEPTION'
}

/**
 * Read the bug-check code straight out of a crash dump header.
 *
 * Windows crash dumps begin with a DUMP_HEADER (signature "PAGE" + "DUMP" or
 * "DU64") whose BugCheckCode field sits at offset 0x38. This reads that one
 * field — it does not attempt a stack walk, which would need the debugger
 * engine and symbols, so the app does not claim to know the faulting driver
 * from a dump.
 */
export async function readDumpBugcheck(
  path: string
): Promise<{ code: string | null; name: string | null; note: string }> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(0x60)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead < 0x40) {
      return { code: null, name: null, note: 'Dump file is truncated.' }
    }
    const signature = buffer.toString('ascii', 0, 4)
    const validDump = buffer.toString('ascii', 4, 8)
    if (signature !== 'PAGE' || (validDump !== 'DUMP' && validDump !== 'DU64')) {
      return { code: null, name: null, note: 'Not a recognised Windows crash dump header.' }
    }
    const raw = buffer.readUInt32LE(0x38)
    if (raw === 0) {
      return { code: null, name: null, note: 'The dump header records no bug-check code.' }
    }
    return {
      code: `0x${raw.toString(16).padStart(8, '0')}`,
      name: STOP_CODE_NAMES[raw] ?? null,
      note: 'Stop code read from the dump header. Identifying the faulting driver would require the Windows debugger and symbols, which GameDriver Pro does not bundle.'
    }
  } catch (error) {
    return { code: null, name: null, note: `Dump could not be read (${describeError(error)}). Reading crash dumps usually requires administrator rights.` }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function groupEvents(events: CrashEvent[]): CrashGroup[] {
  const buckets = new Map<string, CrashEvent[]>()
  for (const event of events) {
    // Group by what actually failed, so repeats of one problem collapse into one
    // finding with a count instead of a wall of identical rows.
    const key = `${event.kind}|${event.module?.toLowerCase() ?? event.providerName.toLowerCase()}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(event)
    else buckets.set(key, [event])
  }

  const groups: CrashGroup[] = []
  for (const [key, bucket] of buckets) {
    const first = bucket[bucket.length - 1]
    const latest = bucket[0]
    if (!first || !latest) continue
    const kind = latest.kind
    const module = latest.module
    const count = bucket.length

    groups.push({
      key,
      title: titleFor(kind, module),
      kind,
      count,
      firstOccurrence: first.timestamp,
      lastOccurrence: latest.timestamp,
      // Two or more of the same fault is a pattern; a single event may be a
      // one-off, and is labelled as such.
      confidence: count >= 2 ? 'likely' : 'possible',
      suspected: module,
      recommendation: recommendationFor(kind, module, count),
      evidence: buildEvidence(bucket)
    })
  }

  return groups.sort((a, b) => b.count - a.count || b.lastOccurrence - a.lastOccurrence)
}

function titleFor(kind: CrashKind, module: string | null): string {
  switch (kind) {
    case 'display-driver-timeout':
      return module ? `Display driver stopped responding (${module})` : 'Display driver stopped responding'
    case 'bugcheck':
      return 'Windows stop error (blue screen)'
    case 'unexpected-shutdown':
      return 'PC shut down without a clean restart'
    case 'app-crash':
      return module ? `Application crash in ${module}` : 'Application crash'
    case 'driver-error':
      return module ? `Service or driver failed to start (${module})` : 'Service or driver failed to start'
    default:
      return 'Windows error'
  }
}

function recommendationFor(kind: CrashKind, module: string | null, count: number): string {
  switch (kind) {
    case 'display-driver-timeout': {
      const known = module?.toLowerCase() ?? ''
      const vendor = /nvlddmkm/.test(known)
        ? 'NVIDIA'
        : /amdkmdag|atikmdag/.test(known)
          ? 'AMD'
          : /igdkmd|igdkmdn/.test(known)
            ? 'Intel'
            : null
      return [
        'Windows recovered the display driver after it stopped responding — this is what Windows calls a TDR.',
        vendor ? `The module named is the ${vendor} display driver.` : null,
        count >= 3
          ? 'Repeated timeouts most often follow a display-driver problem, but overheating, an unstable GPU overclock and a marginal power supply produce the same event.'
          : 'A single timeout is not unusual and may not indicate a fault.',
        'A clean reinstall of the current GPU driver is the usual first step; if it continues, remove any GPU overclock and check temperatures under load.'
      ]
        .filter(Boolean)
        .join(' ')
    }
    case 'bugcheck':
      return 'Check the stop code below against the crash dumps section. Stop errors can come from drivers, memory or storage faults — the stop code narrows it down.'
    case 'unexpected-shutdown':
      return 'Windows did not shut down cleanly. This is recorded for power loss, a hard reset and some stop errors alike, so on its own it does not identify a cause.'
    case 'app-crash':
      return module
        ? `The faulting module Windows recorded was ${module}. If that is a game or a driver component, reinstalling it is the usual next step.`
        : 'Windows did not record a faulting module for these crashes.'
    case 'driver-error':
      return 'A service or driver failed to start. If it belongs to hardware you use, reinstalling that device’s driver normally clears it.'
    default:
      return 'No specific action identified.'
  }
}

function buildEvidence(bucket: CrashEvent[]): string[] {
  const evidence: string[] = []
  const latest = bucket[0]
  if (latest) {
    evidence.push(`Most recent: ${new Date(latest.timestamp).toLocaleString()} — ${latest.providerName} event ${latest.eventId}.`)
    const snippet = latest.message.split(/\r?\n/).find((line) => line.trim().length > 0)
    if (snippet) evidence.push(snippet.trim().slice(0, 220))
  }
  if (bucket.length > 1) {
    evidence.push(`${bucket.length} matching events in the selected window.`)
  }
  return evidence
}

export async function analyseCrashes(windowDays: number): Promise<CrashAnalysis> {
  const days = Math.max(1, Math.min(Math.round(windowDays) || 30, 365))
  const warnings: string[] = []

  const raw = await queryEmitted<RawCrashResponse>(CRASH_SCRIPT, {
    args: { DAYS: String(days) },
    timeoutMs: 90_000
  }).catch((error) => {
    warnings.push(`Event log query failed: ${describeError(error)}`)
    return null
  })
  warnings.push(...arr(raw?.errors))

  const events: CrashEvent[] = arr(raw?.events)
    .filter((row) => row.timestamp !== null)
    .map((row) => {
      const timestamp = Date.parse(row.timestamp ?? '')
      return {
        id: `${row.logName}:${row.recordId}`,
        timestamp: Number.isNaN(timestamp) ? Date.now() : timestamp,
        kind: kindOf(row),
        providerName: row.provider,
        eventId: row.eventId,
        level: levelOf(row.level),
        message: row.message,
        module: moduleFromMessage(row.message)
      }
    })
    .filter((event) => event.level === 'critical' || event.level === 'error' || event.kind === 'display-driver-timeout')

  const dumps: MemoryDumpInfo[] = []
  for (const dump of arr(raw?.dumps)) {
    const bugcheck = await readDumpBugcheck(dump.path)
    const modified = dump.modified ? Date.parse(dump.modified) : Date.now()
    dumps.push({
      path: dump.path,
      sizeBytes: dump.size,
      modifiedAt: Number.isNaN(modified) ? Date.now() : modified,
      kind: dump.kind,
      bugcheckCode: bugcheck.code,
      bugcheckName: bugcheck.name,
      parseNote: bugcheck.note
    })
  }

  const analysis: CrashAnalysis = {
    capturedAt: Date.now(),
    windowDays: days,
    available: raw !== null,
    events,
    groups: groupEvents(events),
    dumps,
    warnings
  }

  log.info('crashes', `Analysed ${events.length} event(s), ${dumps.length} dump(s) over ${days} day(s)`)
  return analysis
}

export function stopCodeName(code: string | null): string | null {
  if (!code) return null
  const numeric = Number.parseInt(code, 16)
  return Number.isNaN(numeric) ? null : (STOP_CODE_NAMES[numeric] ?? null)
}
