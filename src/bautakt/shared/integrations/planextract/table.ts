/**
 * Direkter Import einer Plantabelle (Excel/CSV) ohne KI: Spalten wie ID, Ebene, Vorgang/Name,
 * Dauer, Vorgänger (IDs), Meilenstein, Verantwortlich werden eins zu eins in einen Planentwurf
 * übersetzt. Nichts wird interpretiert oder erfunden, die Dateigröße spielt keine Rolle.
 */

import { addDays, diffDays } from '../../engine/dates.ts'
import { normalizeExtractedPlan, type ExtractedPlan, type ExtractedTask } from './types.ts'

export type Table = string[][]

const COL = {
  id: /^(id|nr\.?|nummer|ticket|schl[uü]ssel|key)$/i,
  level: /ebene|einr[uü]ck|level|gliederungstiefe/i,
  name: /^(vorgang|bezeichnung|name|aufgabe|titel|leistung|zusammenfassung|summary)\b/i,
  duration: /dauer/i,
  start: /^start/i,
  end: /^ende|f[aä]llig/i,
  pred: /vorg[aä]nger/i,
  milestone: /^meilenstein/i,
  responsible: /verantwortlich|zust[aä]ndig|zuweisung|bearbeiter|assignee/i,
  notes: /notiz|bemerkung|kommentar|beschreibung/i,
  category: /^(kategorie|gewerk|typ|art)$/i,
  status: /^status$/i,
  link: /^(link|url)$/i,
} as const
type ColKey = keyof typeof COL

export interface PlanTableLayout {
  headerRow: number
  cols: Partial<Record<ColKey, number>>
}

/** Findet die Kopfzeile einer Plantabelle: Namensspalte plus Dauer, Vorgänger, Ebene oder (ID und Zuständiger). */
export function findPlanTable(table: Table): PlanTableLayout | null {
  for (let r = 0; r < Math.min(table.length, 6); r++) {
    const cols: Partial<Record<ColKey, number>> = {}
    table[r]!.forEach((h, i) => {
      const head = String(h ?? '').trim()
      if (!head) return
      for (const k of Object.keys(COL) as ColKey[]) if (cols[k] === undefined && COL[k].test(head)) cols[k] = i
    })
    if (cols.name !== undefined && (cols.duration !== undefined || cols.pred !== undefined || cols.level !== undefined || (cols.id !== undefined && cols.responsible !== undefined))) return { headerRow: r, cols }
  }
  return null
}

const TRUE = /^(ja|j|yes|y|x|true|1|wahr)$/i
const NOBODY = /^(nicht zugewiesen|unassigned|-|–|—|keiner?|offen)$/i
const ISO = /^\d{4}-\d{2}-\d{2}$/

/** Arbeitstage (Mo-Fr) von Start bis Ende einschließlich. */
function workdaysBetween(start: string, end: string): number {
  const n = diffDays(start, end)
  if (!Number.isFinite(n) || n < 0 || n > 3650) return 0
  let days = 0
  for (let i = 0; i <= n; i++) {
    const wd = new Date(`${addDays(start, i)}T00:00:00Z`).getUTCDay()
    if (wd !== 0 && wd !== 6) days++
  }
  return days
}

/** Plantabelle → Planentwurf; null, wenn die Tabelle nicht wie ein Plan aussieht. */
export function tableToExtractedPlan(table: Table, name: string, fileName: string): ExtractedPlan | null {
  const layout = findPlanTable(table)
  if (!layout) return null
  const { cols, headerRow } = layout
  const cell = (row: string[], k: ColKey) => (cols[k] === undefined ? '' : String(row[cols[k]!] ?? '').trim())

  const rows = table.slice(headerRow + 1).filter((r) => cell(r, 'name'))
  if (!rows.length) return null

  const used = new Set<string>()
  const keys = rows.map((r, i) => {
    let key = cell(r, 'id') || `r${i + 1}`
    while (used.has(key)) key += '_'
    used.add(key)
    return key
  })
  const levels = rows.map((r) => {
    const n = parseInt(cell(r, 'level'), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  })

  const tasks: ExtractedTask[] = []
  const stack: { level: number; key: string }[] = []
  let unknownPreds = 0
  rows.forEach((r, i) => {
    const level = levels[i]!
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop()
    const parent = stack[stack.length - 1]?.key ?? null
    const hasChildren = i + 1 < rows.length && levels[i + 1]! > level
    const category = cell(r, 'category')
    const isMilestone = TRUE.test(cell(r, 'milestone')) || /^meilenstein$/i.test(category)
    const type: ExtractedTask['type'] = isMilestone ? 'milestone' : hasChildren ? (level <= 1 || /^phase$/i.test(category) ? 'phase' : 'group') : 'task'

    let dur = Math.round(Number(cell(r, 'duration').replace(',', '.')))
    if (!(dur > 0)) {
      const s = cell(r, 'start')
      const e = cell(r, 'end')
      dur = ISO.test(s) && ISO.test(e) ? workdaysBetween(s, e) : 0
    }
    const preds = cell(r, 'pred').split(/[,;\s]+/).filter(Boolean)
    const responsible = cell(r, 'responsible')
    const status = cell(r, 'status')
    const notes = [category && type === 'task' ? `Kategorie: ${category}` : '', status ? `Status: ${status}` : '', cell(r, 'notes'), cell(r, 'link')].filter(Boolean).join('\n')
    tasks.push({
      key: keys[i]!,
      name: cell(r, 'name'),
      type,
      parent_key: parent,
      duration: type === 'milestone' ? 0 : dur > 0 ? dur : 1,
      responsible: responsible && !NOBODY.test(responsible) ? responsible : null,
      notes,
      source_excerpt: null,
      depends_on: preds
        .filter((p) => {
          const ok = used.has(p) && p !== keys[i]
          if (!ok) unknownPreds++
          return ok
        })
        .map((p) => ({ predecessor_key: p, type: 'FS' as const, lag_days: 0 })),
    })
    stack.push({ level, key: keys[i]! })
  })

  const warnings = [`Tabelle direkt übernommen (ohne KI): ${tasks.length} Zeilen.`]
  if (unknownPreds) warnings.push(`${unknownPreds} Vorgänger-Verweise zeigen auf unbekannte IDs und wurden ignoriert.`)
  return normalizeExtractedPlan({ name, tasks, warnings }, { source: 'document', name, reference: fileName })
}
