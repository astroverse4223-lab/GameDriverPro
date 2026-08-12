import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { log, describeError } from './logger'
import type { GameProfile, HistoryRecord, HistoryKind } from '../../shared/types'

/**
 * Local store for driver history, game profiles and settings.
 *
 * SQLite (node:sqlite) is used when the running Electron build exposes it;
 * otherwise the app degrades to an atomic JSON file with the same interface.
 * Which engine is live is reported verbatim in Developer diagnostics rather
 * than hidden — the app never claims a capability it does not have.
 */

interface Engine {
  name: string
  addHistory(record: Omit<HistoryRecord, 'id'>): number
  listHistory(limit: number): HistoryRecord[]
  clearHistory(): void
  getProfile(gameId: string): GameProfile | null
  saveProfile(profile: GameProfile): void
  getKv(key: string): string | null
  setKv(key: string, value: string): void
  count(): number
  close(): void
}

const nodeRequire = createRequire(__filename)

let engine: Engine | null = null
let dbPath = ''

function dataDir(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// --- SQLite -----------------------------------------------------------------

function createSqliteEngine(): Engine | null {
  let DatabaseSync: unknown
  try {
    // Available in Electron builds whose bundled Node exposes node:sqlite.
    const mod = nodeRequire('node:sqlite') as { DatabaseSync?: unknown }
    DatabaseSync = mod.DatabaseSync
    if (typeof DatabaseSync !== 'function') return null
  } catch {
    return null
  }

  try {
    dbPath = join(dataDir(), 'gamedriver.db')
    const Ctor = DatabaseSync as new (path: string) => SqliteDb
    const db = new Ctor(dbPath)
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        device TEXT,
        category TEXT,
        from_version TEXT,
        to_version TEXT,
        result TEXT NOT NULL,
        source TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_ts ON history (ts DESC);
      CREATE TABLE IF NOT EXISTS profiles (
        game_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    return {
      name: 'node:sqlite',
      addHistory(record) {
        const stmt = db.prepare(
          'INSERT INTO history (ts, kind, device, category, from_version, to_version, result, source, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        const info = stmt.run(
          record.timestamp,
          record.kind,
          record.device,
          record.category,
          record.fromVersion,
          record.toVersion,
          record.result,
          record.source,
          record.detail
        )
        return Number(info.lastInsertRowid ?? 0)
      },
      listHistory(limit) {
        const rows = db.prepare('SELECT * FROM history ORDER BY ts DESC LIMIT ?').all(limit) as SqliteHistoryRow[]
        return rows.map((row) => ({
          id: Number(row.id),
          timestamp: Number(row.ts),
          kind: row.kind as HistoryKind,
          device: row.device ?? null,
          category: row.category ?? null,
          fromVersion: row.from_version ?? null,
          toVersion: row.to_version ?? null,
          result: row.result as HistoryRecord['result'],
          source: row.source ?? null,
          detail: row.detail ?? null
        }))
      },
      clearHistory() {
        db.exec('DELETE FROM history')
      },
      getProfile(gameId) {
        const row = db.prepare('SELECT json FROM profiles WHERE game_id = ?').get(gameId) as { json?: string } | undefined
        if (!row?.json) return null
        try {
          return JSON.parse(row.json) as GameProfile
        } catch {
          return null
        }
      },
      saveProfile(profile) {
        db.prepare(
          'INSERT INTO profiles (game_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(game_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at'
        ).run(profile.gameId, JSON.stringify(profile), profile.updatedAt)
      },
      getKv(key) {
        const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined
        return row?.value ?? null
      },
      setKv(key, value) {
        db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
          key,
          value
        )
      },
      count() {
        const row = db.prepare('SELECT COUNT(*) AS n FROM history').get() as { n?: number } | undefined
        return Number(row?.n ?? 0)
      },
      close() {
        db.close()
      }
    }
  } catch (error) {
    log.warn('db', `SQLite unavailable, falling back to JSON store: ${describeError(error)}`)
    return null
  }
}

interface SqliteDb {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid?: number | bigint }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  close(): void
}

interface SqliteHistoryRow {
  id: number
  ts: number
  kind: string
  device: string | null
  category: string | null
  from_version: string | null
  to_version: string | null
  result: string
  source: string | null
  detail: string | null
}

// --- JSON fallback ----------------------------------------------------------

interface JsonShape {
  nextId: number
  history: HistoryRecord[]
  profiles: Record<string, GameProfile>
  kv: Record<string, string>
}

function createJsonEngine(): Engine {
  dbPath = join(dataDir(), 'gamedriver.json')
  let state: JsonShape = { nextId: 1, history: [], profiles: {}, kv: {} }
  if (existsSync(dbPath)) {
    try {
      state = { ...state, ...(JSON.parse(readFileSync(dbPath, 'utf8')) as JsonShape) }
    } catch (error) {
      log.warn('db', `Store unreadable, starting fresh: ${describeError(error)}`)
    }
  }

  const flush = () => {
    try {
      const tmp = `${dbPath}.tmp`
      writeFileSync(tmp, JSON.stringify(state), 'utf8')
      renameSync(tmp, dbPath)
    } catch (error) {
      log.error('db', `Could not persist store: ${describeError(error)}`)
    }
  }

  return {
    name: 'json-fallback',
    addHistory(record) {
      const id = state.nextId++
      state.history.unshift({ ...record, id })
      if (state.history.length > 2000) state.history.length = 2000
      flush()
      return id
    },
    listHistory(limit) {
      return state.history.slice(0, limit)
    },
    clearHistory() {
      state.history = []
      flush()
    },
    getProfile(gameId) {
      return state.profiles[gameId] ?? null
    },
    saveProfile(profile) {
      state.profiles[profile.gameId] = profile
      flush()
    },
    getKv(key) {
      return state.kv[key] ?? null
    },
    setKv(key, value) {
      state.kv[key] = value
      flush()
    },
    count() {
      return state.history.length
    },
    close() {
      flush()
    }
  }
}

// --- Public surface ---------------------------------------------------------

function db(): Engine {
  if (!engine) {
    engine = createSqliteEngine() ?? createJsonEngine()
    log.info('db', `Store engine: ${engine.name} (${dbPath})`)
  }
  return engine
}

export const store = {
  addHistory(record: Omit<HistoryRecord, 'id'>): number {
    try {
      return db().addHistory(record)
    } catch (error) {
      log.error('db', `addHistory failed: ${describeError(error)}`)
      return -1
    }
  },
  listHistory(limit = 200): HistoryRecord[] {
    try {
      return db().listHistory(Math.max(1, Math.min(limit, 2000)))
    } catch (error) {
      log.error('db', `listHistory failed: ${describeError(error)}`)
      return []
    }
  },
  clearHistory(): void {
    try {
      db().clearHistory()
    } catch (error) {
      log.error('db', `clearHistory failed: ${describeError(error)}`)
    }
  },
  getProfile(gameId: string): GameProfile | null {
    try {
      return db().getProfile(gameId)
    } catch {
      return null
    }
  },
  saveProfile(profile: GameProfile): void {
    try {
      db().saveProfile(profile)
    } catch (error) {
      log.error('db', `saveProfile failed: ${describeError(error)}`)
    }
  },
  getKv(key: string): string | null {
    try {
      return db().getKv(key)
    } catch {
      return null
    }
  },
  setKv(key: string, value: string): void {
    try {
      db().setKv(key, value)
    } catch (error) {
      log.error('db', `setKv failed: ${describeError(error)}`)
    }
  },
  status(): { engine: string; path: string; ok: boolean; records: number } {
    try {
      const e = db()
      return { engine: e.name, path: dbPath, ok: true, records: e.count() }
    } catch (error) {
      return { engine: 'unavailable', path: dbPath, ok: false, records: 0 }
    }
  },
  close(): void {
    try {
      engine?.close()
    } catch {
      /* shutting down anyway */
    }
  }
}
