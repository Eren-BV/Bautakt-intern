/**
 * Arbeitskalender: welche Tage sind Arbeitstage? Berücksichtigt Wochentage, gesetzliche
 * Feiertage der Projektregion (berechnet, siehe holidays.ts), Betriebsurlaub, Schließtage
 * und explizit als Arbeitstag markierte Ausnahmen (z. B. Samstag-Sonderschicht).
 * Alle Operationen arbeiten auf Tagnummern (siehe dates.ts).
 *
 * Kalender-Schichten (Priorität von oben nach unten, siehe `resolveCalendars`):
 *   1. Vorgangskalender (task.calendar_id)
 *   2. Ressourcenkalender (resource.calendar_id)
 *   3. Firmenkalender (calendar.company_id = task.company_id)
 *   4. Kategorie-Kalender (calendar.trade_id = task.trade_id)
 *   5. Projektkalender (project.calendar_id bzw. calendar.project_id)
 *   6. Org-Standardkalender
 *   + gesetzliche Feiertage der Projektregion (und der Regionen der Schichten)
 *
 * Regel je Datum: die spezifischste Schicht mit einer expliziten Ausnahme entscheidet
 * (auch „Arbeitstag“ als Ausnahme, z. B. Sonderschicht an einem Feiertag). Ohne Ausnahme
 * gilt: Feiertag → frei, sonst die Wochentagsregel der spezifischsten Schicht.
 * Dadurch gelten Betriebsurlaub der Firma UND Schließtage des Projekts gleichzeitig.
 */

import type { CalendarException, ISODate, ProjectCalendar, Resource, Task } from '../types.ts'
import { fromDayNumber, toDayNumber, weekdayOf } from './dates.ts'
import { HolidayLookup } from './holidays.ts'

export interface WorkCalendar {
  id: string
  name: string
  isWorkday(day: number): boolean
  /** Erster Arbeitstag >= day */
  nextWorkday(day: number): number
  /** Letzter Arbeitstag <= day */
  prevWorkday(day: number): number
  /**
   * Bewegt sich `n` Arbeitstage von einem Arbeitstag weg (n<0 rückwärts).
   * Ist `day` kein Arbeitstag, wird zuerst auf den nächsten (n>=0) bzw.
   * vorherigen (n<0) Arbeitstag gerundet.
   */
  addWorkdays(day: number, n: number): number
  /** Anzahl Arbeitstage im geschlossenen Intervall [a, b]; 0 falls b < a */
  countWorkdays(a: number, b: number): number
  /** Name der Ausnahme/des Feiertags an diesem Tag (null = normaler Tag oder Wochenende) */
  exceptionName(day: number): string | null
  /** Art des arbeitsfreien Tags - für Darstellung und Erklärungen */
  dayKind(day: number): DayKind
}

export type DayKind = 'working' | 'weekend' | 'holiday' | 'vacation' | 'closed'

const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5]

export interface CalendarLayer {
  id: string
  name: string
  /** Wochentagsregel dieser Schicht (leer = von der nächsten Schicht erben) */
  working_days: number[] | null
  exceptions: CalendarException[]
  /** Feiertagsregion dieser Schicht (z. B. Firma in anderem Bundesland) */
  holiday_region: string | null
}

interface Override {
  working: boolean
  name: string
  kind: DayKind
}

const exceptionKind = (ex: CalendarException): DayKind =>
  ex.type === 'working' ? 'working' : ex.type === 'holiday' ? 'holiday' : ex.type === 'vacation' ? 'vacation' : 'closed'

/**
 * Baut einen Kalender aus geordneten Schichten (spezifischste zuerst) und den gesetzlichen
 * Feiertagen. `holidayRegion` ist die Projektregion; Schichten können eigene Regionen tragen.
 */
export function buildLayeredCalendar(layers: CalendarLayer[], holidayRegion: string | null, label?: { id: string; name: string }): WorkCalendar {
  const overrideMaps: Map<number, Override>[] = []
  for (const layer of layers) {
    const m = new Map<number, Override>()
    for (const ex of layer.exceptions) m.set(toDayNumber(ex.date), { working: ex.type === 'working', name: ex.name, kind: exceptionKind(ex) })
    overrideMaps.push(m)
  }
  const hasOverrides = overrideMaps.some((m) => m.size > 0)
  const workingLayer = layers.find((l) => l.working_days && l.working_days.length > 0)
  const working = new Set(workingLayer?.working_days ?? DEFAULT_WORKING_DAYS)
  const regions = new Set<string>()
  if (holidayRegion) regions.add(holidayRegion)
  for (const l of layers) if (l.holiday_region) regions.add(l.holiday_region)
  const lookups = [...regions].map((r) => new HolidayLookup(r))
  const holidayName = (day: number): string | null => {
    for (const l of lookups) {
      const n = l.get(day)
      if (n) return n
    }
    return null
  }
  const override = (day: number): Override | undefined => {
    for (const m of overrideMaps) {
      const o = m.get(day)
      if (o) return o
    }
    return undefined
  }
  const name = label?.name ?? layers[0]?.name ?? 'Standard (Mo–Fr)'
  const id = label?.id ?? (layers.map((l) => l.id).join('+') || 'default')

  const isWorkday = (day: number): boolean => {
    const o = override(day)
    if (o) return o.working
    if (lookups.length && holidayName(day)) return false
    return working.has(weekdayOf(day))
  }
  const nextWorkday = (day: number): number => {
    let d = day
    let guard = 0
    while (!isWorkday(d)) {
      d++
      if (++guard > 400) throw new Error(`Kalender "${name}" hat keine Arbeitstage`)
    }
    return d
  }
  const prevWorkday = (day: number): number => {
    let d = day
    let guard = 0
    while (!isWorkday(d)) {
      d--
      if (++guard > 400) throw new Error(`Kalender "${name}" hat keine Arbeitstage`)
    }
    return d
  }
  const addWorkdays = (day: number, n: number): number => {
    if (n >= 0) {
      let d = nextWorkday(day)
      let left = n
      while (left > 0) {
        d = nextWorkday(d + 1)
        left--
      }
      return d
    }
    let d = prevWorkday(day)
    let left = -n
    while (left > 0) {
      d = prevWorkday(d - 1)
      left--
    }
    return d
  }
  const countWorkdays = (a: number, b: number): number => {
    if (b < a) return 0
    let count = 0
    let d = a
    // Für große Spannen ohne Ausnahmen/Feiertage: Wochen im Block zählen
    const fullWeeks = Math.floor((b - a + 1) / 7)
    if (fullWeeks > 2 && !hasOverrides && lookups.length === 0) {
      count += fullWeeks * working.size
      d = a + fullWeeks * 7
    }
    for (; d <= b; d++) if (isWorkday(d)) count++
    return count
  }
  const exceptionName = (day: number): string | null => override(day)?.name ?? holidayName(day)
  const dayKind = (day: number): DayKind => {
    const o = override(day)
    if (o) return o.kind
    if (holidayName(day)) return 'holiday'
    return working.has(weekdayOf(day)) ? 'working' : 'weekend'
  }

  return { id, name, isWorkday, nextWorkday, prevWorkday, addWorkdays, countWorkdays, exceptionName, dayKind }
}

/** Einfacher Kalender aus einer Definition + Ausnahmen (ohne Schichten), optional mit Feiertagsregion. */
export function buildCalendar(
  calendar: Pick<ProjectCalendar, 'id' | 'name' | 'working_days'> | null,
  exceptions: CalendarException[] = [],
  holidayRegion: string | null = null,
): WorkCalendar {
  return buildLayeredCalendar(
    [{ id: calendar?.id ?? 'default', name: calendar?.name ?? 'Standard (Mo–Fr)', working_days: calendar?.working_days ?? null, exceptions, holiday_region: null }],
    holidayRegion,
    { id: calendar?.id ?? 'default', name: calendar?.name ?? 'Standard (Mo–Fr)' },
  )
}

/** Bequemlichkeit für ISO-Strings */
export function addWorkdaysISO(cal: WorkCalendar, iso: ISODate, n: number): ISODate {
  return fromDayNumber(cal.addWorkdays(toDayNumber(iso), n))
}

export function countWorkdaysISO(cal: WorkCalendar, a: ISODate, b: ISODate): number {
  return cal.countWorkdays(toDayNumber(a), toDayNumber(b))
}

/** Ende eines Vorgangs mit Dauer `duration` ab Start `start` (inklusiv). Dauer 0 → Start. */
export function endFromDuration(cal: WorkCalendar, start: number, duration: number): number {
  if (duration <= 0) return cal.nextWorkday(start)
  return cal.addWorkdays(start, duration - 1)
}

/** Dauer in Arbeitstagen zwischen Start und Ende (inklusiv) */
export function durationFromDates(cal: WorkCalendar, start: number, end: number): number {
  return cal.countWorkdays(start, end)
}

export interface CalendarResolutionInput {
  calendars: ProjectCalendar[]
  exceptions: CalendarException[]
  projectId: string
  projectCalendarId: string | null
  /** Feiertagsregion des Projekts, z. B. "DE-BY" */
  holidayRegion?: string | null
  /** Für Ressourcenkalender (resource.calendar_id) */
  resources?: Resource[]
}

export interface ResolvedCalendars {
  /** Projektkalender (Basis für Projektstart, Darstellung, Sammelvorgänge) */
  base: WorkCalendar
  /** Wirksamer Kalender eines Vorgangs aus allen Schichten (memoisiert) */
  forTask(task: Pick<Task, 'calendar_id' | 'trade_id' | 'company_id' | 'resource_id'>): WorkCalendar
  /** Einzelkalender nach ID (nur diese Definition + Feiertage, ohne weitere Schichten) */
  byId: Map<string, WorkCalendar>
}

/**
 * Löst die Kalender-Schichten für ein Projekt auf. Projektspezifische Kategorie-/Firmen-
 * kalender gewinnen gegenüber org-weiten.
 */
export function resolveCalendars(input: CalendarResolutionInput): ResolvedCalendars {
  const { calendars, exceptions, projectId, projectCalendarId } = input
  const region = input.holidayRegion ?? null
  const exByCal = new Map<string, CalendarException[]>()
  for (const ex of exceptions) {
    const list = exByCal.get(ex.calendar_id) ?? []
    list.push(ex)
    exByCal.set(ex.calendar_id, list)
  }
  const toLayer = (c: ProjectCalendar): CalendarLayer => ({ id: c.id, name: c.name, working_days: c.working_days?.length ? c.working_days : null, exceptions: exByCal.get(c.id) ?? [], holiday_region: c.holiday_region ?? null })
  const applies = (c: ProjectCalendar) => c.project_id === projectId || c.project_id === null
  const pick = (list: ProjectCalendar[]): ProjectCalendar | undefined => list.find((c) => c.project_id === projectId) ?? list[0]

  const calById = new Map(calendars.map((c) => [c.id, c]))
  const byTrade = new Map<string, ProjectCalendar>()
  const byCompany = new Map<string, ProjectCalendar>()
  for (const c of calendars) {
    if (!applies(c)) continue
    if (c.trade_id && !c.company_id) {
      const cur = byTrade.get(c.trade_id)
      if (!cur || c.project_id === projectId) byTrade.set(c.trade_id, c)
    }
    if (c.company_id) {
      const cur = byCompany.get(c.company_id)
      if (!cur || c.project_id === projectId) byCompany.set(c.company_id, c)
    }
  }
  const projectCal = projectCalendarId ? calById.get(projectCalendarId) : undefined
  const projectOwn = pick(calendars.filter((c) => c.project_id === projectId && !c.trade_id && !c.company_id))
  const orgDefault = calendars.find((c) => c.is_default && !c.project_id && !c.trade_id && !c.company_id)
  const baseLayers: CalendarLayer[] = []
  const projectLayerCal = projectCal ?? projectOwn
  if (projectLayerCal) baseLayers.push(toLayer(projectLayerCal))
  if (orgDefault && orgDefault.id !== projectLayerCal?.id) baseLayers.push(toLayer(orgDefault))
  if (baseLayers.length === 0) baseLayers.push({ id: 'default', name: 'Standard (Mo–Fr)', working_days: null, exceptions: [], holiday_region: null })
  const base = buildLayeredCalendar(baseLayers, region, { id: baseLayers[0].id, name: baseLayers[0].name })

  const byId = new Map<string, WorkCalendar>()
  for (const c of calendars) byId.set(c.id, buildLayeredCalendar([toLayer(c)], region, { id: c.id, name: c.name }))

  const resById = new Map((input.resources ?? []).map((r) => [r.id, r]))
  const memo = new Map<string, WorkCalendar>()
  const forTask: ResolvedCalendars['forTask'] = (task) => {
    const resCalId = task.resource_id ? (resById.get(task.resource_id)?.calendar_id ?? null) : null
    const companyCal = task.company_id ? byCompany.get(task.company_id) : undefined
    const tradeCal = task.trade_id ? byTrade.get(task.trade_id) : undefined
    const key = `${task.calendar_id ?? ''}|${resCalId ?? ''}|${companyCal?.id ?? ''}|${tradeCal?.id ?? ''}`
    if (key === '|||') return base
    const cached = memo.get(key)
    if (cached) return cached
    const layers: CalendarLayer[] = []
    const taskCal = task.calendar_id ? calById.get(task.calendar_id) : undefined
    if (taskCal) layers.push(toLayer(taskCal))
    const resCal = resCalId ? calById.get(resCalId) : undefined
    if (resCal && resCal.id !== taskCal?.id) layers.push(toLayer(resCal))
    if (companyCal && !layers.some((l) => l.id === companyCal.id)) layers.push(toLayer(companyCal))
    if (tradeCal && !layers.some((l) => l.id === tradeCal.id)) layers.push(toLayer(tradeCal))
    for (const l of baseLayers) if (!layers.some((x) => x.id === l.id)) layers.push(l)
    const cal = buildLayeredCalendar(layers, region, { id: layers[0].id, name: layers[0].name })
    memo.set(key, cal)
    return cal
  }
  return { base, forTask, byId }
}

// ---------------------------------------------------------------- Erklärungen (Feiertage im Zeitraum)

export interface NonWorkingDay {
  date: ISODate
  day: number
  name: string
  kind: DayKind
}

/** Arbeitsfreie Tage im Zeitraum [start, end] - ohne gewöhnliche Wochenenden, wenn `includeWeekends` false. */
export function nonWorkingDaysBetween(cal: WorkCalendar, start: number, end: number, includeWeekends = false): NonWorkingDay[] {
  const out: NonWorkingDay[] = []
  for (let d = start; d <= end && d - start < 3660; d++) {
    if (cal.isWorkday(d)) continue
    const kind = cal.dayKind(d)
    if (kind === 'weekend' && !includeWeekends) continue
    out.push({ date: fromDayNumber(d), day: d, name: cal.exceptionName(d) ?? (kind === 'weekend' ? 'Wochenende' : 'Arbeitsfrei'), kind })
  }
  return out
}

const WEEKDAY_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
const KIND_LABEL: Record<DayKind, string> = { working: 'Arbeitstag', weekend: 'Wochenende', holiday: 'Feiertag', vacation: 'Betriebsurlaub', closed: 'arbeitsfrei' }

export function dayKindLabel(kind: DayKind): string {
  return KIND_LABEL[kind]
}

export function weekdayLong(day: number): string {
  return WEEKDAY_LONG[weekdayOf(day)]
}

/**
 * Verständliche Erklärung, warum ein Zeitraum länger ist als seine Arbeitstage:
 * „Christi Himmelfahrt am Donnerstag, 14.05., ist arbeitsfrei. Für 5 Arbeitstage wird
 * Montag, 18.05., zusätzlich benötigt.“
 */
export function explainSpan(cal: WorkCalendar, start: number, duration: number): { end: number; nonWorking: NonWorkingDay[]; sentences: string[] } {
  const s = cal.nextWorkday(start)
  const end = endFromDuration(cal, s, duration)
  const nonWorking = nonWorkingDaysBetween(cal, s, end, false)
  const sentences: string[] = []
  if (nonWorking.length === 0) return { end, nonWorking, sentences }
  const fmt = (d: number) => {
    const iso = fromDayNumber(d)
    return `${WEEKDAY_LONG[weekdayOf(d)]}, ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`
  }
  const holidays = nonWorking.filter((n) => n.kind === 'holiday')
  const others = nonWorking.filter((n) => n.kind !== 'holiday')
  if (holidays.length === 1) sentences.push(`In diesem Zeitraum liegt ein Feiertag: ${holidays[0].name} am ${fmt(holidays[0].day)} ist arbeitsfrei.`)
  else if (holidays.length > 1) sentences.push(`In diesem Zeitraum liegen ${holidays.length} Feiertage: ${holidays.map((h) => `${h.name} (${fmt(h.day)})`).join(', ')}.`)
  if (others.length === 1) sentences.push(`${others[0].name} am ${fmt(others[0].day)} ist arbeitsfrei.`)
  else if (others.length > 1) sentences.push(`${others.length} weitere arbeitsfreie Tage: ${others.map((o) => `${o.name} (${fmt(o.day)})`).join(', ')}.`)
  // Zusätzlich benötigte Arbeitstage: Ende ohne diese Ausnahmen wäre früher
  const naive = buildLayeredCalendar([{ id: 'naive', name: 'naive', working_days: null, exceptions: [], holiday_region: null }], null)
  const naiveEnd = endFromDuration(naive, s, duration)
  if (end > naiveEnd) {
    const addl: string[] = []
    for (let d = naiveEnd + 1; d <= end; d++) if (cal.isWorkday(d)) addl.push(fmt(d))
    if (addl.length) sentences.push(`Für ${duration} Arbeitstage ${addl.length === 1 ? 'wird' : 'werden'} ${addl.join(' und ')} zusätzlich benötigt.`)
  }
  return { end, nonWorking, sentences }
}
