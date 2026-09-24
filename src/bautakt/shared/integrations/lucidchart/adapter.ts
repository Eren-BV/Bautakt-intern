/**
 * Lucidchart → Plan. Grundlage ist die Dokumentinhalts-Antwort der Lucid-API
 * (GET /documents/{id}/contents): Seiten mit Shapes, Linien und Gruppen.
 *
 * Abbildung: Seite → Phase · Gruppe/Container → Bereich · Shape → Vorgang ·
 * Raute/Terminator → Meilenstein · Linie → Abhängigkeit.
 * Dauer und Verantwortliche werden aus dem Shape-Text gelesen:
 *   „Rohplanung (3 AT) @Edis Sejdinovic“  bzw. „Verantwortlich: Edis Sejdinovic“.
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
export interface LucidEndpoint {
  type?: string
  /** ältere Antwortform */
  shapeId?: string
  /** aktuelle Antwortform der Lucid-API */
  connectedTo?: string
  style?: string
}
export interface LucidLine {
  id: string
  endpoint1?: LucidEndpoint
  endpoint2?: LucidEndpoint
  text?: string
  textAreas?: Record<string, string> | { text?: string }[]
}

/** Die Lucid-API nennt das verbundene Element je nach Version `connectedTo` oder `shapeId`. */
function endpointId(ep?: LucidEndpoint): string | undefined {
  return ep?.connectedTo ?? ep?.shapeId
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
  return values.filter(Boolean).join('\n').trim()
}

const MAX_NAME = 90

/**
 * Formen enthalten oft ganze Textblöcke. Als Aufgabenname dient die erste Zeile
 * bzw. der erste Satz, gekürzt auf eine lesbare Länge.
 */
export function shortenLabel(raw: string): string {
  let head = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? raw.trim()
  if (head.length > MAX_NAME) {
    const sentence = head.slice(0, MAX_NAME + 40).match(/^(.{20,}?[.!?:])\s/)
    if (sentence) head = sentence[1]!
  }
  if (head.length > MAX_NAME) {
    const cut = head.slice(0, MAX_NAME)
    const space = cut.lastIndexOf(' ')
    head = `${(space > 40 ? cut.slice(0, space) : cut).replace(/[,;:\-–]$/, '')}…`
  }
  return head.trim()
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
  return 'task'
}

type AnyShape = LucidShape & { contains?: { shapes?: string[]; lines?: string[] } }

function isContainer(s: AnyShape): boolean {
  const cls = (s.class ?? '').toLowerCase()
  return !!s.contains?.shapes?.length || /container|swimlane|frame|pool/.test(cls)
}

function stepNumber(text: string): number | null {
  const m = text.match(/^\s*(?:schritt|step|phase|teil|modul|kapitel)?\s*(\d{1,3})\b/i)
  return m ? Number(m[1]) : null
}

/**
 * Übliche Abfolge von Phasen. Liefert Lucidchart keine Positionen, ordnen wir die Rahmen
 * über bekannte Begriffe ihrer Überschrift; unbekannte Rahmen bleiben in Dokumentreihenfolge
 * am Ende. In der Vorschau lässt sich alles nachträglich verschieben.
 */
const PHASE_ORDER: [RegExp, number][] = [
  [/legende|legend/i, 999],
  [/anfrage|interessent|akquise|lead/i, 10],
  [/einwertung|besichtigung|aufmaß|aufmass/i, 20],
  [/angebot|kalkulation/i, 30],
  [/verhandlung/i, 40],
  [/auftrag/i, 50],
  [/vergabe|subunternehmer/i, 60],
  [/projektplanung|werkplanung|planung/i, 70],
  [/bemusterung/i, 80],
  [/bauvorbereitung|vorbereitung/i, 90],
  [/baustellenvorbereitung/i, 95],
  [/baustellenbeginn|baubeginn/i, 100],
  [/bauphase|ausführung|ausfuehrung|umsetzung|sanierung|energetisch|garten/i, 110],
  [/verspätung|verspaetung|störung|stoerung/i, 115],
  [/nachtrag/i, 120],
  [/kostenmanagement|controlling|budget/i, 125],
  [/abnahme/i, 130],
  [/mängel|maengel|mangel/i, 140],
  [/rechnung|schlussrechnung|zahlung/i, 150],
  [/abschluss|übergabe|uebergabe|dokumentation/i, 160],
]

export function phaseRank(title: string): number {
  for (const [re, rank] of PHASE_ORDER) if (re.test(title)) return rank
  return 500
}

/**
 * Leserichtung: von links nach rechts, von oben nach unten. Mit Koordinaten werden
 * Zeilen gebildet (ähnliche y-Lage) und darin nach x sortiert. Liefert die API keine
 * Koordinaten – das ist bei Lucidchart der Normalfall –, folgen wir den Pfeilketten:
 * jede Kette startet bei einer Form ohne eingehenden Pfeil und wird komplett
 * durchlaufen, bevor die nächste Kette beginnt. Ohne Pfeile zählt eine Nummer im
 * Text („Schritt 2“), sonst die Reihenfolge im Dokument.
 */
function readingOrder<T extends AnyShape>(items: T[], lines: LucidLine[]): T[] {
  const withBox = items.filter((s) => s.boundingBox)
  if (withBox.length === items.length && items.length > 0) {
    const sorted = items.slice().sort((a, b) => a.boundingBox!.y - b.boundingBox!.y)
    const rows: T[][] = []
    for (const s of sorted) {
      const row = rows.at(-1)
      const ref = row?.[0]?.boundingBox
      if (row && ref && s.boundingBox!.y < ref.y + Math.max(ref.h, 20) / 2) row.push(s)
      else rows.push([s])
    }
    return rows.flatMap((r) => r.sort((a, b) => a.boundingBox!.x - b.boundingBox!.x))
  }

  const ids = new Set(items.map((s) => s.id))
  const index = new Map(items.map((s, i) => [s.id, i]))
  const indeg = new Map(items.map((s) => [s.id, 0]))
  const next = new Map<string, string[]>()
  for (const l of lines) {
    const a = endpointId(l.endpoint1), b = endpointId(l.endpoint2)
    if (!a || !b || a === b || !ids.has(a) || !ids.has(b)) continue
    next.set(a, [...(next.get(a) ?? []), b])
    indeg.set(b, (indeg.get(b) ?? 0) + 1)
  }

  const rank = (s: T) => stepNumber(textOf(s)) ?? 1e6 + index.get(s.id)!
  const cmp = (a: T, b: T) => rank(a) - rank(b) || index.get(a.id)! - index.get(b.id)!
  const byId = new Map(items.map((s) => [s.id, s]))
  const remaining = new Map(indeg)
  const out: T[] = []
  const seen = new Set<string>()

  // Ketten vollständig verfolgen: Startpunkte zuerst, dann jeweils dem Pfeil folgen.
  const walk = (start: T) => {
    const stack = [start]
    while (stack.length) {
      const s = stack.pop()!
      if (seen.has(s.id)) continue
      seen.add(s.id)
      out.push(s)
      const successors = (next.get(s.id) ?? [])
        .map((id) => byId.get(id))
        .filter((n): n is T => !!n && !seen.has(n.id))
        .sort(cmp)
      // Nachfolger, deren übrige Vorgänger schon erledigt sind, kommen direkt dran.
      const ready: T[] = []
      const later: T[] = []
      for (const n of successors) {
        remaining.set(n.id, (remaining.get(n.id) ?? 1) - 1)
        ;((remaining.get(n.id) ?? 0) <= 0 ? ready : later).push(n)
      }
      for (const n of [...later, ...ready].reverse()) stack.push(n)
    }
  }

  for (const s of items.filter((s) => (indeg.get(s.id) ?? 0) === 0).sort(cmp)) walk(s)
  // Zyklen bzw. nicht erreichte Formen nach Nummer/Dokumentreihenfolge anhängen
  for (const s of items.filter((s) => !seen.has(s.id)).sort(cmp)) walk(s)
  return out
}


/** Lucid-Dokumentinhalt in das neutrale Importformat übersetzen. */
export function lucidToExtractedPlan(doc: LucidDocumentContents, documentId: string): ExtractedPlan {
  const tasks: ExtractedTask[] = []
  const warnings: string[] = []
  const byShapeId = new Map<string, string>()
  const pages = doc.pages ?? []
  const multiPage = pages.length > 1
  let phaseCounter = 0

  const pushStep = (s: AnyShape, pageKey: string, parent: string | null) => {
    const raw = textOf(s)
    if (!raw) return
    const parsed = parseShapeText(shortenLabel(raw))
    const name = shortenLabel(parsed.name)
    const type = typeOf(s, name)
    const key = `${pageKey}_s${s.id}`
    byShapeId.set(s.id, key)
    tasks.push({
      key, name, type, parent_key: parent,
      duration: type === 'milestone' ? 0 : (parsed.duration ?? 1),
      responsible: parsed.responsible,
      notes: raw.length > name.length ? raw : '',
      depends_on: [],
    })
  }

  pages.forEach((page, pi) => {
    const pageKey = `p${pi + 1}`
    const shapes: AnyShape[] = [...((page.items?.shapes ?? []) as AnyShape[])]
    const lines: LucidLine[] = [...(page.items?.lines ?? [])]
    for (const g of page.items?.groups ?? []) {
      shapes.push(...((g.items?.shapes ?? []) as AnyShape[]))
      lines.push(...(g.items?.lines ?? []))
    }
    const shapeById = new Map(shapes.map((s) => [s.id, s]))

    // Container → Phase; enthaltene Formen → Vorgänge
    const containers = shapes.filter(isContainer)
    const childOf = new Map<string, string>()
    for (const c of containers) for (const id of c.contains?.shapes ?? []) if (shapeById.has(id) && !isContainer(shapeById.get(id)!)) childOf.set(id, c.id)
    // Container ohne contains-Angabe: Zuordnung über Koordinaten
    for (const s of shapes) {
      if (childOf.has(s.id) || isContainer(s) || !s.boundingBox) continue
      const b = s.boundingBox, cx = b.x + b.w / 2, cy = b.y + b.h / 2
      const c = containers.find((c) => c.boundingBox && cx >= c.boundingBox.x && cx <= c.boundingBox.x + c.boundingBox.w && cy >= c.boundingBox.y && cy <= c.boundingBox.y + c.boundingBox.h)
      if (c) childOf.set(s.id, c.id)
    }

    const pageParent = multiPage && !containers.length ? pageKey : null
    if (pageParent) tasks.push({ key: pageKey, name: page.title?.trim() || `Seite ${pi + 1}`, type: 'phase', parent_key: null, duration: 1 })

    // Freie Formen (außerhalb von Containern) und Container gemeinsam in Leserichtung
    const topLevel = shapes.filter((s) => isContainer(s) || !childOf.has(s.id))
    for (const s of readingOrder(topLevel, lines)) {
      if (!isContainer(s)) { pushStep(s, pageKey, pageParent); continue }
      phaseCounter++
      const title = shortenLabel(textOf(s))
      const phaseKey = `${pageKey}_c${s.id}`
      tasks.push({ key: phaseKey, name: !title || /^\d+$/.test(title) ? `Phase ${title || phaseCounter}` : title, type: 'phase', parent_key: null, duration: 1 })
      const children = shapes.filter((x) => childOf.get(x.id) === s.id)
      for (const ch of readingOrder(children, lines)) pushStep(ch, pageKey, phaseKey)
    }

    for (const l of lines) {
      const fromId = endpointId(l.endpoint1), toId = endpointId(l.endpoint2)
      const from = fromId ? byShapeId.get(fromId) : undefined
      const to = toId ? byShapeId.get(toId) : undefined

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
