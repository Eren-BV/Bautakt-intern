/**
 * Lucidchart → Plan. Grundlage ist die Dokumentinhalts-Antwort der Lucid-API
 * (GET /documents/{id}/contents): Seiten mit Shapes, Linien und Gruppen.
 *
 * Abbildung: Seite → Phase · Gruppe/Container → Bereich · Shape → Vorgang ·
 * Raute/Terminator → Meilenstein · Linie → Abhängigkeit.
 * Dauer und Verantwortliche werden aus dem Shape-Text gelesen:
 *   „Rohplanung (3 AT) @Jan Pfeiffer“  bzw. „Verantwortlich: Jan Pfeiffer“.
 */

import type { TaskType } from '../../types.ts'
import type { ExtractedPlan, ExtractedTask } from '../planextract/types.ts'

export interface LucidShape {
  id: string
  class?: string
  text?: string
  textAreas?: Record<string, string> | { text?: string }[]
  boundingBox?: { x: number; y: number; w: number; h: number }
  groupId?: string | null
}
export interface LucidLine {
  id: string
  endpoint1?: { type?: string; shapeId?: string; style?: string }
  endpoint2?: { type?: string; shapeId?: string; style?: string }
  text?: string
  textAreas?: Record<string, string> | { text?: string }[]
}
export interface LucidPage {
  id: string
  title?: string
  items?: { shapes?: LucidShape[]; lines?: LucidLine[]; groups?: { id: string; title?: string; items?: { shapes?: LucidShape[]; lines?: LucidLine[] } }[] }
}
export interface LucidDocumentContents {
  id?: string
  title?: string
  pages?: LucidPage[]
}

const MILESTONE_CLASSES = ['diamond', 'terminator', 'decision', 'startend', 'circle', 'ellipse']

function textOf(item: { text?: string; textAreas?: Record<string, string> | { text?: string }[] }): string {
  if (item.text?.trim()) return item.text.trim()
  const ta = item.textAreas
  if (!ta) return ''
  const values = Array.isArray(ta) ? ta.map((t) => t?.text ?? '') : Object.values(ta)
  return values.filter(Boolean).join(' ').trim()
}

/** „Name (3 AT) @Person“ → Bestandteile */
export function parseShapeText(raw: string): { name: string; duration: number | null; responsible: string | null } {
  let text = raw.replace(/\s+/g, ' ').trim()
  let responsible: string | null = null
  const respLabel = text.match(/(?:verantwortlich|zuständig|owner)\s*[:=]\s*([^()|,;]+)/i)
  if (respLabel) {
    responsible = respLabel[1]!.trim()
    text = text.replace(respLabel[0], '').trim()
  }
  const at = text.match(/@\s*([A-Za-zÄÖÜäöüß.\- ]{2,40})/)
  if (!responsible && at) {
    responsible = at[1]!.trim()
    text = text.replace(at[0], '').trim()
  }
  let duration: number | null = null
  const dur = text.match(/\(?\s*(\d{1,3})\s*(?:at|arbeitstage?|ate|tage?|t|d|days?)\s*\)?/i)
  if (dur) {
    duration = Number(dur[1])
    text = text.replace(dur[0], '').trim()
  }
  const name = text.replace(/[()\-–|]+$/, '').trim()
  return { name: name || raw.trim(), duration, responsible }
}

function typeOf(shape: LucidShape, name: string): TaskType {
  const cls = (shape.class ?? '').toLowerCase()
  if (MILESTONE_CLASSES.some((c) => cls.includes(c))) return 'milestone'
  if (/^(start|ende|abschluss|freigabe|meilenstein|abnahme)\b/i.test(name)) return 'milestone'
  if (cls.includes('container') || cls.includes('swimlane') || cls.includes('frame')) return 'group'
  return 'task'
}

/** Lucid-Dokumentinhalt in das neutrale Importformat übersetzen. */
export function lucidToExtractedPlan(doc: LucidDocumentContents, documentId: string): ExtractedPlan {
  const tasks: ExtractedTask[] = []
  const warnings: string[] = []
  const byShapeId = new Map<string, string>()
  const pages = doc.pages ?? []

  pages.forEach((page, pi) => {
    const pageKey = `p${pi + 1}`
    const shapes: LucidShape[] = [...(page.items?.shapes ?? [])]
    const lines: LucidLine[] = [...(page.items?.lines ?? [])]
    const groups = page.items?.groups ?? []
    const multiPage = pages.length > 1
    if (multiPage) {
      tasks.push({ key: pageKey, name: page.title?.trim() || `Seite ${pi + 1}`, type: 'group', parent_key: null, duration: 1 })
    }
    for (const g of groups) {
      const gk = `${pageKey}_g${g.id}`
      tasks.push({ key: gk, name: g.title?.trim() || 'Bereich', type: 'group', parent_key: multiPage ? pageKey : null, duration: 1 })
      for (const s of g.items?.shapes ?? []) shapes.push({ ...s, groupId: gk })
      lines.push(...(g.items?.lines ?? []))
    }

    const sorted = shapes.slice().sort((a, b) => (a.boundingBox?.y ?? 0) - (b.boundingBox?.y ?? 0) || (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0))
    for (const s of sorted) {
      const raw = textOf(s)
      if (!raw) continue
      const parsed = parseShapeText(raw)
      const type = typeOf(s, parsed.name)
      const key = `${pageKey}_s${s.id}`
      byShapeId.set(s.id, key)
      tasks.push({
        key,
        name: parsed.name,
        type,
        parent_key: s.groupId ?? (multiPage ? pageKey : null),
        duration: type === 'milestone' ? 0 : (parsed.duration ?? 1),
        responsible: parsed.responsible,
        notes: '',
        depends_on: [],
      })
    }

    for (const l of lines) {
      const from = l.endpoint1?.shapeId ? byShapeId.get(l.endpoint1.shapeId) : undefined
      const to = l.endpoint2?.shapeId ? byShapeId.get(l.endpoint2.shapeId) : undefined
      if (!from || !to || from === to) continue
      const label = textOf(l)
      const lag = label.match(/(-?\d{1,3})\s*(?:at|tage?|t)\b/i)
      const target = tasks.find((t) => t.key === to)
      if (!target) continue
      target.depends_on = [...(target.depends_on ?? []), { predecessor_key: from, type: 'FS', lag_days: lag ? Number(lag[1]) : 0 }]
    }
  })

  if (!tasks.length) warnings.push('Im Diagramm wurden keine beschrifteten Formen gefunden.')
  return {
    source: 'lucidchart',
    name: doc.title?.trim() || 'Lucidchart-Plan',
    reference: documentId,
    tasks,
    warnings,
  }
}
