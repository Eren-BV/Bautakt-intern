/**
 * Import-Pipeline: FILE → PARSER → NORMALIZED IMPORT DATA → MAPPING → VALIDATION →
 * USER REVIEW → PROJECT DATA. Bewusst UI-unabhängig.
 *
 * Parser: CSV ist real implementiert. Excel/GAEB/PDF/IFC/API sind als Parser-Vertrag
 * vorbereitet (`ImportParser`) - kein unzuverlässiges PDF-Raten.
 */

import type { DependencyType, ISODate } from '../types.ts'

export interface ParsedTable {
  headers: string[]
  rows: string[][]
}

export interface ImportParser {
  sourceType: 'csv' | 'excel' | 'gaeb' | 'pdf' | 'api' | 'ifc'
  /** Liefert eine normalisierte Tabelle; wirft bei nicht unterstütztem Format */
  parse(input: string | Uint8Array): ParsedTable
}

/** Normalisierte Zeile - gemeinsames Format aller Parser */
export interface NormalizedItem {
  row: number
  position: string
  description: string
  quantity: number | null
  unit: string | null
  trade: string | null
  section: string | null
  duration: number | null
  productivity_rate: number | null
  start: ISODate | null
  predecessor_row: number | null
  dep_type: DependencyType | null
  lag: number | null
  unit_price: number | null
  total_price: number | null
}

export type ImportField = keyof Omit<NormalizedItem, 'row'>

export interface ImportMapping {
  position: string | null
  description: string | null
  quantity: string | null
  unit: string | null
  trade: string | null
  section: string | null
  duration: string | null
  productivity_rate: string | null
  start: string | null
  predecessor_row: string | null
  dep_type: string | null
  lag: string | null
  unit_price: string | null
  total_price: string | null
}

// ---- Parser: CSV (Semikolon/Komma/Tab, Anführungszeichen, BOM)
export function parseCsv(text: string): ParsedTable {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const firstLine = src.split(/\r?\n/)[0] ?? ''
  const delim = [';', ',', '\t'].map((d) => ({ d, n: (firstLine.match(new RegExp(d === '\t' ? '\t' : `\\${d}`, 'g')) ?? []).length })).sort((a, b) => b.n - a.n)[0]?.d ?? ';'
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === delim) {
      cur.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      cur.push(field)
      field = ''
      if (cur.some((x) => x.trim() !== '')) rows.push(cur)
      cur = []
    } else field += ch
  }
  cur.push(field)
  if (cur.some((x) => x.trim() !== '')) rows.push(cur)
  const headers = (rows.shift() ?? []).map((h) => h.trim())
  return { headers, rows }
}

export const csvParser: ImportParser = { sourceType: 'csv', parse: (input) => parseCsv(typeof input === 'string' ? input : new TextDecoder().decode(input)) }

// ---- Mapping: Spaltenüberschriften automatisch erkennen, Nutzer kann überschreiben
const AUTO: Record<ImportField, RegExp> = {
  position: /^(pos|position|oz|ordnungszahl|nr|#)/i,
  description: /^(bezeichnung|beschreibung|vorgang|arbeit|kurztext|langtext|name|titel|description)/i,
  quantity: /^(menge|qty|quantity|anzahl)/i,
  unit: /^(einheit|me|unit|mengeneinheit)/i,
  trade: /^(gewerk|trade|los)/i,
  section: /^(bauabschnitt|abschnitt|bauteil|geschoss|section)/i,
  duration: /^(dauer|duration|at|arbeitstage)/i,
  productivity_rate: /^(leistung|leistungswert|produktivit|rate)/i,
  start: /^(start|beginn|anfang)/i,
  predecessor_row: /^(vorg[äa]nger|predecessor|pred)/i,
  dep_type: /^(beziehung|typ|dep_type|art)/i,
  lag: /^(lag|verz[öo]gerung|puffer)/i,
  unit_price: /^(ep|einheitspreis|unit_price)/i,
  total_price: /^(gp|gesamtpreis|total|betrag)/i,
}

export function autoMapping(headers: string[]): ImportMapping {
  const m = Object.fromEntries((Object.keys(AUTO) as ImportField[]).map((k) => [k, null])) as unknown as ImportMapping
  for (const h of headers) {
    for (const k of Object.keys(AUTO) as ImportField[]) {
      if (!m[k] && AUTO[k].test(h.trim())) {
        m[k] = h
        break
      }
    }
  }
  return m
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null
  const n = Number(v.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : null
}
const date = (v: string | undefined): ISODate | null => {
  if (!v) return null
  const s = v.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/)
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return null
}

export function mapImportRows(table: ParsedTable, override?: Partial<ImportMapping>): { mapping: ImportMapping; items: NormalizedItem[] } {
  const mapping = { ...autoMapping(table.headers), ...Object.fromEntries(Object.entries(override ?? {}).filter(([, v]) => v !== undefined)) } as ImportMapping
  const idx = (f: ImportField) => (mapping[f] ? table.headers.indexOf(mapping[f]!) : -1)
  const get = (row: string[], f: ImportField) => (idx(f) >= 0 ? row[idx(f)] : undefined)
  const items: NormalizedItem[] = table.rows.map((row, i) => {
    const predRaw = get(row, 'predecessor_row')
    const predNum = predRaw ? Number((predRaw.match(/^\s*(\d+)/) ?? [])[1]) : NaN
    const depTypeRaw = (get(row, 'dep_type') ?? predRaw?.replace(/[\d\s+-]/g, '') ?? '').toUpperCase()
    return {
      row: i,
      position: (get(row, 'position') ?? String(i + 1)).trim(),
      description: (get(row, 'description') ?? '').trim(),
      quantity: num(get(row, 'quantity')),
      unit: get(row, 'unit')?.trim() || null,
      trade: get(row, 'trade')?.trim() || null,
      section: get(row, 'section')?.trim() || null,
      duration: num(get(row, 'duration')),
      productivity_rate: num(get(row, 'productivity_rate')),
      start: date(get(row, 'start')),
      predecessor_row: Number.isFinite(predNum) && predNum >= 1 ? predNum - 1 : null,
      dep_type: (['FS', 'SS', 'FF', 'SF'] as DependencyType[]).includes(depTypeRaw as DependencyType) ? (depTypeRaw as DependencyType) : null,
      lag: num(get(row, 'lag')) ?? (predRaw?.match(/([+-]\d+)/) ? Number(predRaw.match(/([+-]\d+)/)![1]) : null),
      unit_price: num(get(row, 'unit_price')),
      total_price: num(get(row, 'total_price')),
    }
  })
  return { mapping, items }
}

export function validateImport(mapped: { mapping: ImportMapping; items: NormalizedItem[] }): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!mapped.mapping.description) errors.push('Keine Spalte für die Bezeichnung erkannt – bitte zuordnen.')
  mapped.items.forEach((it, i) => {
    if (!it.description) errors.push(`Zeile ${i + 1}: Bezeichnung fehlt.`)
    if (it.predecessor_row !== null && (it.predecessor_row >= mapped.items.length || it.predecessor_row === i)) errors.push(`Zeile ${i + 1}: Vorgänger-Zeile ${it.predecessor_row + 1} ungültig.`)
    if (it.duration !== null && it.duration < 0) errors.push(`Zeile ${i + 1}: negative Dauer.`)
    if (it.quantity !== null && !it.unit) warnings.push(`Zeile ${i + 1}: Menge ohne Einheit.`)
    if (it.duration === null && !(it.quantity && it.productivity_rate)) warnings.push(`Zeile ${i + 1}: keine Dauer – wird mit 1 AT angelegt.`)
  })
  return { errors: errors.slice(0, 20), warnings: warnings.slice(0, 20) }
}
