import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { log } from './logger'

/**
 * Windows PowerShell / CIM bridge.
 *
 * Scripts are compile-time constants in this codebase — never assembled from
 * renderer input. Where a query needs a parameter it is handed over through the
 * child's environment (`GDP_ARG_*`) and read with `$env:`, so there is no string
 * interpolation into a shell and therefore no injection surface.
 *
 * Scripts are passed as UTF-16LE base64 via -EncodedCommand, which sidesteps
 * every layer of Windows command-line quoting.
 */

const PS_EXE = 'powershell.exe'
const DEFAULT_TIMEOUT = 25_000
// The startup sweep issues four independent queries (core hardware, storage,
// network, driver inventory). Allowing four in flight keeps the boot sequence
// bounded by the slowest query rather than by queue depth.
const MAX_CONCURRENT = 4

const PREAMBLE = [
  '$ErrorActionPreference = "Stop"',
  '$ProgressPreference = "SilentlyContinue"',
  '$WarningPreference = "SilentlyContinue"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'
].join('; ')

export interface PsOptions {
  timeoutMs?: number
  /** Values are exposed to the script as $env:GDP_ARG_<KEY>. */
  args?: Record<string, string>
  /** Non-zero exit / stderr is expected for this query; resolve instead of throw. */
  tolerant?: boolean
}

export class PowerShellError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null
  ) {
    super(message)
    this.name = 'PowerShellError'
  }
}

let active = 0
const queue: (() => void)[] = []

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++
    return Promise.resolve()
  }
  return new Promise((resolve) => queue.push(resolve))
}

function release(): void {
  const next = queue.shift()
  if (next) {
    next()
    return
  }
  active--
}

function encode(script: string): string {
  return Buffer.from(`${PREAMBLE}; ${script}`, 'utf16le').toString('base64')
}

/** Run a script and return raw stdout. */
export async function runRaw(script: string, options: PsOptions = {}): Promise<string> {
  await acquire()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(options.args ?? {})) {
    env[`GDP_ARG_${key}`] = value
  }

  return new Promise<string>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(
        PS_EXE,
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)],
        { windowsHide: true, env }
      )
    } catch (error) {
      release()
      reject(new PowerShellError(`Could not start PowerShell: ${String(error)}`, '', null))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      release()
      reject(new PowerShellError(`PowerShell query timed out after ${timeoutMs}ms`, stderr, null))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      release()
      reject(new PowerShellError(`PowerShell failed to launch: ${error.message}`, stderr, null))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      release()
      if (code !== 0 && !options.tolerant) {
        reject(new PowerShellError(`PowerShell exited with code ${code}`, stderr.trim(), code))
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * Run a script whose final statement pipes into ConvertTo-Json and parse it.
 * Always returns an array — PowerShell collapses single-element arrays, so the
 * script is wrapped in `@(...)` before serialisation.
 */
export async function queryJson<T>(script: string, options: PsOptions = {}): Promise<T[]> {
  // Windows PowerShell 5.1 has no ConvertTo-Json -AsArray, and it unwraps
  // single-element arrays, so re-wrap by hand to keep the shape stable.
  const wrapped =
    `$__r = @(${script}); ` +
    'if ($__r.Count -eq 0) { "[]" } ' +
    'else { $__j = ConvertTo-Json -InputObject $__r -Depth 5 -Compress; ' +
    'if ($__r.Count -eq 1) { "[" + $__j + "]" } else { $__j } }'
  const stdout = await runRaw(wrapped, options)
  const text = stdout.trim()
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as T[]) : [parsed as T]
  } catch (error) {
    log.warn('powershell', `Unparseable JSON output: ${text.slice(0, 300)}`)
    throw new PowerShellError(`PowerShell returned unparseable JSON: ${String(error)}`, text.slice(0, 500), 0)
  }
}

/** Same as queryJson but never throws — returns [] and logs instead. */
export async function tryQueryJson<T>(label: string, script: string, options: PsOptions = {}): Promise<T[]> {
  try {
    return await queryJson<T>(script, options)
  } catch (error) {
    log.warn('powershell', `${label} failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/** Single-object variant of queryJson. */
export async function queryOne<T>(script: string, options: PsOptions = {}): Promise<T | null> {
  const rows = await queryJson<T>(script, options)
  return rows[0] ?? null
}

export async function tryQueryOne<T>(label: string, script: string, options: PsOptions = {}): Promise<T | null> {
  const rows = await tryQueryJson<T>(label, script, options)
  return rows[0] ?? null
}

/**
 * For scripts that serialise themselves (the multi-section snapshot queries,
 * which need a deeper ConvertTo-Json depth and per-section error capture).
 * The script's stdout is parsed as-is — it must not be wrapped again.
 */
export async function queryEmitted<T>(script: string, options: PsOptions = {}): Promise<T | null> {
  const stdout = (await runRaw(script, options)).trim()
  if (!stdout) return null
  // A script may legitimately print a warning line before its JSON payload.
  const start = stdout.search(/[{[]/)
  if (start < 0) {
    throw new PowerShellError('PowerShell produced no JSON payload', stdout.slice(0, 500), 0)
  }
  try {
    return JSON.parse(stdout.slice(start)) as T
  } catch (error) {
    log.warn('powershell', `Unparseable emitted JSON: ${stdout.slice(0, 300)}`)
    throw new PowerShellError(`PowerShell returned unparseable JSON: ${String(error)}`, stdout.slice(0, 500), 0)
  }
}

/**
 * Long-lived PowerShell process emitting one JSON object per line. Used by the
 * performance monitor so polling does not pay ~150ms of process start-up every
 * tick.
 */
export class PowerShellStream {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''

  constructor(
    private readonly script: string,
    private readonly onLine: (row: unknown) => void,
    private readonly onError: (message: string) => void
  ) {}

  start(args: Record<string, string> = {}): boolean {
    if (this.child) return true
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const [key, value] of Object.entries(args)) env[`GDP_ARG_${key}`] = value

    try {
      this.child = spawn(
        PS_EXE,
        [
          '-NoProfile',
          '-NonInteractive',
          '-NoLogo',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encode(this.script)
        ],
        { windowsHide: true, env }
      )
    } catch (error) {
      this.onError(`Could not start telemetry stream: ${String(error)}`)
      return false
    }

    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))
    this.child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) log.warn('telemetry', text.slice(0, 200))
    })
    this.child.on('error', (error) => this.onError(error.message))
    this.child.on('close', () => {
      this.child = null
    })
    return true
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.startsWith('{') || line.startsWith('[')) {
        try {
          this.onLine(JSON.parse(line))
        } catch {
          /* partial or malformed line — skip this tick rather than crash */
        }
      }
      index = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > 64_000) this.buffer = ''
  }

  get running(): boolean {
    return this.child !== null
  }

  stop(): void {
    if (!this.child) return
    const child = this.child
    this.child = null
    this.buffer = ''
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a script that reports its own progress as one JSON object per line, and
 * resolve once it exits. Used by driver installation, where the only truthful
 * progress signal available is the stage the Windows Update Agent has reached.
 */
export function runNdjson(
  script: string,
  onLine: (row: unknown) => void,
  options: PsOptions = {}
): Promise<{ exitCode: number | null; lines: number }> {
  return new Promise((resolve, reject) => {
    let lines = 0
    let settled = false
    const stream = new PowerShellStream(
      script,
      (row) => {
        lines += 1
        onLine(row)
      },
      (message) => {
        if (settled) return
        settled = true
        reject(new PowerShellError(message, '', null))
      }
    )

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stream.stop()
      reject(new PowerShellError(`Operation timed out after ${options.timeoutMs ?? 600_000}ms`, '', null))
    }, options.timeoutMs ?? 600_000)

    if (!stream.start(options.args ?? {})) {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(new PowerShellError('Could not start PowerShell', '', null))
      }
      return
    }

    const poll = setInterval(() => {
      if (stream.running || settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      resolve({ exitCode: 0, lines })
    }, 250)
  })
}

/** Run a non-PowerShell executable and capture stdout (used for nvidia-smi). */
export function runExe(exe: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`${exe} timed out`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => (stdout += c))
    child.stderr.on('data', (c: string) => (stderr += c))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${exe} exited with ${code}`))
        return
      }
      resolve(stdout)
    })
  })
}
