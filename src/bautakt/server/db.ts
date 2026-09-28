/**
 * Datenzugriff über Lovable Cloud (Postgres). Die ursprünglichen SQL-Abfragen bleiben
 * unverändert erhalten: Platzhalter `?` werden serverseitig gebunden, die Tabellen liegen
 * im Schema `bautakt` und sind ausschließlich über die Serverrolle erreichbar.
 *
 * Migrationen liegen weiterhin als nummerierte SQL-Dateien in ./migrations und werden
 * beim ersten Request angewendet (protokolliert in `schema_migrations`).
 */

export type SQLInputValue = string | number | bigint | boolean | null

export type Row = Record<string, unknown>

type Admin = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>
}

let adminPromise: Promise<Admin> | null = null

async function admin(): Promise<Admin> {
  if (!adminPromise) {
    adminPromise = import('@/integrations/supabase/client.server').then((m) => m.supabaseAdmin as unknown as Admin)
  }
  return adminPromise
}

const params = (values: SQLInputValue[]) => values.map((v) => (typeof v === 'bigint' ? Number(v) : v))

export interface BatchStatement {
  sql: string
  params?: SQLInputValue[]
  /** Erwartete Anzahl betroffener Zeilen; weicht sie ab, wird der ganze Batch zurückgerollt. */
  expect?: number
  /** Kennung für den Fehlerfall (BatchExpectationError.tag). */
  tag?: string
}

/** Eine Batch-Anweisung hat nicht die erwartete Zeilenzahl getroffen - nichts wurde geschrieben. */
export class BatchExpectationError extends Error {
  readonly tag: string
  constructor(tag: string) {
    super(`Batch abgebrochen: ${tag}`)
    this.tag = tag
  }
}

export class Db {
  async all<T = Row>(query: string, ...values: SQLInputValue[]): Promise<T[]> {
    const client = await admin()
    const { data, error } = await client.rpc('bautakt_query', { q: query, p: params(values) })
    if (error) throw new Error(`Datenbankfehler: ${error.message} — ${query}`)
    return (data as T[]) ?? []
  }

  async get<T = Row>(query: string, ...values: SQLInputValue[]): Promise<T | undefined> {
    const rows = await this.all<T>(query, ...values)
    return rows[0]
  }

  async run(query: string, ...values: SQLInputValue[]): Promise<number> {
    const client = await admin()
    const { data, error } = await client.rpc('bautakt_exec', { q: query, p: params(values) })
    if (error) throw new Error(`Datenbankfehler: ${error.message} — ${query}`)
    return Number(data ?? 0)
  }

  async script(sql: string): Promise<void> {
    const client = await admin()
    const { error } = await client.rpc('bautakt_script', { q: sql })
    if (error) throw new Error(`Migrationsfehler: ${error.message}`)
  }

  /**
   * Mehrere Anweisungen in einem einzigen RPC-Aufruf (siehe migrations/010_bautakt_batch_rpc.sql).
   * Läuft serverseitig in einer Transaktion: wirft eine Anweisung, sind auch alle vorherigen
   * dieses Aufrufs zurückgerollt - im Gegensatz zu einzelnen insert()/run()-Aufrufen.
   */
  async batch(statements: BatchStatement[]): Promise<number[]> {
    if (!statements.length) return []
    const client = await admin()
    const items = statements.map((s) => ({
      q: s.sql,
      p: params(s.params ?? []),
      ...(s.expect !== undefined ? { expect: s.expect, tag: s.tag ?? 'rows' } : {}),
    }))
    const { data, error } = await client.rpc('bautakt_batch', { items })
    if (error) {
      const expectation = /BAUTAKT_EXPECT:([a-z_]+)/.exec(error.message)
      if (expectation) throw new BatchExpectationError(expectation[1])
      throw new Error(`Datenbankfehler (Batch): ${error.message}`)
    }
    return (data as number[]) ?? []
  }

  /**
   * Klammert zusammengehörige Schreibvorgänge. Jede Anweisung läuft einzeln gegen die
   * Datenbank, ein Abbruch mittendrin rollt vorherige Schritte also nicht zurück.
   */
  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    return await fn()
  }

  /** INSERT aus Objekt; Booleans → 0/1, Arrays/Objekte → JSON */
  async insert(table: string, data: object): Promise<void> {
    const { sql, params } = buildInsert(table, data)
    await this.run(sql, ...(params ?? []))
  }

  async upsert(table: string, data: object, conflictKeys: string[] = ['id']): Promise<void> {
    const { sql, params } = buildUpsert(table, data, conflictKeys)
    await this.run(sql, ...(params ?? []))
  }

  async update(table: string, id: string, data: object): Promise<void> {
    const patch = data as Record<string, unknown>
    const keys = Object.keys(patch)
    if (!keys.length) return
    await this.run(
      `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => toSql(patch[k])),
      id,
    )
  }

  /** Wendet ausstehende SQL-Migrationen an. */
  async migrate(files: Record<string, string>): Promise<void> {
    await this.script(
      'CREATE TABLE IF NOT EXISTS bautakt.schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    )
    const applied = new Set(
      (await this.all<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name),
    )
    for (const name of Object.keys(files).sort()) {
      if (applied.has(name)) continue
      await this.script(files[name])
      await this.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', name, nowISO())
      console.log(`[db] Migration ${name} angewendet`)
    }
  }
}

/** Baut ein INSERT-Statement (Platzhalter/Parameter) - Basis für Db.insert() und Batch-Aufrufe. */
export function buildInsert(table: string, data: object): BatchStatement {
  const obj = data as Record<string, unknown>
  const keys = Object.keys(obj)
  const values = keys.map((k) => toSql(obj[k]))
  return { sql: `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, params: values }
}

/** Baut ein INSERT ... ON CONFLICT DO UPDATE-Statement - Basis für Db.upsert() und Batch-Aufrufe. */
export function buildUpsert(table: string, data: object, conflictKeys: string[] = ['id']): BatchStatement {
  const obj = data as Record<string, unknown>
  const keys = Object.keys(obj)
  const values = keys.map((k) => toSql(obj[k]))
  const updates = keys.filter((k) => !conflictKeys.includes(k)).map((k) => `${k} = excluded.${k}`)
  const tail = updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING'
  return {
    sql: `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) ON CONFLICT(${conflictKeys.join(', ')}) ${tail}`,
    params: values,
  }
}

export function toSql(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v
  return JSON.stringify(v)
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function newId(prefix = ''): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let id = ''
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length]
  return prefix ? `${prefix}_${id}` : id
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  let out = ''
  for (const b of buf) out += String.fromCharCode(b)
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function nowISO(): string {
  return new Date().toISOString()
}
