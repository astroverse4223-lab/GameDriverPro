import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

type Level = 'info' | 'warn' | 'error' | 'debug'

const RING_SIZE = 400
const ring: string[] = []
let logPath: string | null = null
let writeQueue: Promise<void> = Promise.resolve()

function ensurePath(): string | null {
  if (logPath) return logPath
  try {
    logPath = join(app.getPath('userData'), 'logs', 'gamedriver.log')
    return logPath
  } catch {
    return null
  }
}

function write(level: Level, scope: string, message: string): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] (${scope}) ${message}`
  ring.push(line)
  if (ring.length > RING_SIZE) ring.shift()

  if (process.env.NODE_ENV === 'development' || level === 'error') {
    const sink = level === 'error' ? console.error : console.log
    sink(line)
  }

  const path = ensurePath()
  if (!path) return
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(join(path, '..'), { recursive: true })
      await appendFile(path, `${line}\n`, 'utf8')
    })
    .catch(() => {
      /* logging must never be able to break the app */
    })
}

export const log = {
  info: (scope: string, message: string) => write('info', scope, message),
  warn: (scope: string, message: string) => write('warn', scope, message),
  error: (scope: string, message: string) => write('error', scope, message),
  debug: (scope: string, message: string) => {
    if (process.env.NODE_ENV === 'development') write('debug', scope, message)
  },
  tail: (count = 120): string[] => ring.slice(-count),
  path: (): string => ensurePath() ?? '(unavailable)'
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return JSON.stringify(error)
}
