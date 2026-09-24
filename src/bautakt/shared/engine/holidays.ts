/**
 * Gesetzliche Feiertage - deterministisch berechnet, nicht gespeichert. Ein Projekt kennt
 * Land + Region (z. B. DE-BY); die Engine leitet daraus die arbeitsfreien Tage ab und
 * berücksichtigt sie in JEDER Terminberechnung (nicht nur in der Darstellung).
 *
 * Abgedeckt: Deutschland mit allen 16 Bundesländern, Österreich, Schweiz (national).
 * Regionale Sonderfälle (Augsburger Friedensfest, Fronleichnam nur in Teilen Sachsens/
 * Thüringens) sind bewusst nicht enthalten - dafür gibt es Kalender-Ausnahmen.
 */

import type { ISODate } from '../types.ts'
import { fromDayNumber, toDayNumber, weekdayOf } from './dates.ts'

export interface Holiday {
  date: ISODate
  name: string
}

export interface HolidayRegion {
  /** z. B. "DE-BY" */
  code: string
  country: 'DE' | 'AT' | 'CH'
  name: string
}

export const HOLIDAY_REGIONS: HolidayRegion[] = [
  { code: 'DE-BW', country: 'DE', name: 'Baden-Württemberg' },
  { code: 'DE-BY', country: 'DE', name: 'Bayern' },
  { code: 'DE-BE', country: 'DE', name: 'Berlin' },
  { code: 'DE-BB', country: 'DE', name: 'Brandenburg' },
  { code: 'DE-HB', country: 'DE', name: 'Bremen' },
  { code: 'DE-HH', country: 'DE', name: 'Hamburg' },
  { code: 'DE-HE', country: 'DE', name: 'Hessen' },
  { code: 'DE-MV', country: 'DE', name: 'Mecklenburg-Vorpommern' },
  { code: 'DE-NI', country: 'DE', name: 'Niedersachsen' },
  { code: 'DE-NW', country: 'DE', name: 'Nordrhein-Westfalen' },
  { code: 'DE-RP', country: 'DE', name: 'Rheinland-Pfalz' },
  { code: 'DE-SL', country: 'DE', name: 'Saarland' },
  { code: 'DE-SN', country: 'DE', name: 'Sachsen' },
  { code: 'DE-ST', country: 'DE', name: 'Sachsen-Anhalt' },
  { code: 'DE-SH', country: 'DE', name: 'Schleswig-Holstein' },
  { code: 'DE-TH', country: 'DE', name: 'Thüringen' },
  { code: 'DE', country: 'DE', name: 'Deutschland (nur bundesweite Feiertage)' },
  { code: 'AT', country: 'AT', name: 'Österreich' },
  { code: 'CH', country: 'CH', name: 'Schweiz (national)' },
]

export const DEFAULT_HOLIDAY_REGION = 'DE-BY'

export function regionName(code: string | null | undefined): string {
  return HOLIDAY_REGIONS.find((r) => r.code === code)?.name ?? code ?? 'keine Region'
}

/** Feiertage eines Jahres für eine Region (sortiert). Unbekannte Region → bundesweit DE. */
export function holidaysFor(year: number, region: string | null | undefined): Holiday[] {
  const code = HOLIDAY_REGIONS.some((r) => r.code === region) ? (region as string) : 'DE'
  const easter = easterSunday(year)
  const e = (offset: number, name: string): Holiday => ({ date: fromDayNumber(easter + offset), name })
  const fixed = (m: number, d: number, name: string): Holiday => ({ date: `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, name })
  const list: Holiday[] = []

  if (code === 'AT') {
    list.push(fixed(1, 1, 'Neujahr'), fixed(1, 6, 'Heilige Drei Könige'), e(1, 'Ostermontag'), fixed(5, 1, 'Staatsfeiertag'), e(39, 'Christi Himmelfahrt'), e(50, 'Pfingstmontag'), e(60, 'Fronleichnam'),
      fixed(8, 15, 'Mariä Himmelfahrt'), fixed(10, 26, 'Nationalfeiertag'), fixed(11, 1, 'Allerheiligen'), fixed(12, 8, 'Mariä Empfängnis'), fixed(12, 25, 'Christtag'), fixed(12, 26, 'Stefanitag'))
    return sortHolidays(list)
  }
  if (code === 'CH') {
    list.push(fixed(1, 1, 'Neujahr'), e(-2, 'Karfreitag'), e(1, 'Ostermontag'), e(39, 'Auffahrt'), e(50, 'Pfingstmontag'), fixed(8, 1, 'Bundesfeiertag'), fixed(12, 25, 'Weihnachten'), fixed(12, 26, 'Stephanstag'))
    return sortHolidays(list)
  }

  // Deutschland: bundesweit
  list.push(fixed(1, 1, 'Neujahr'), e(-2, 'Karfreitag'), e(1, 'Ostermontag'), fixed(5, 1, 'Tag der Arbeit'), e(39, 'Christi Himmelfahrt'), e(50, 'Pfingstmontag'),
    fixed(10, 3, 'Tag der Deutschen Einheit'), fixed(12, 25, '1. Weihnachtstag'), fixed(12, 26, '2. Weihnachtstag'))
  const st = code.startsWith('DE-') ? code.slice(3) : ''
  const has = (...states: string[]) => states.includes(st)
  if (has('BW', 'BY', 'ST')) list.push(fixed(1, 6, 'Heilige Drei Könige'))
  if (has('BE', 'MV')) list.push(fixed(3, 8, 'Internationaler Frauentag'))
  if (has('BW', 'BY', 'HE', 'NW', 'RP', 'SL')) list.push(e(60, 'Fronleichnam'))
  if (has('BY', 'SL')) list.push(fixed(8, 15, 'Mariä Himmelfahrt'))
  if (has('TH')) list.push(fixed(9, 20, 'Weltkindertag'))
  if (has('BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH')) list.push(fixed(10, 31, 'Reformationstag'))
  if (has('BW', 'BY', 'NW', 'RP', 'SL')) list.push(fixed(11, 1, 'Allerheiligen'))
  if (has('SN')) list.push({ date: fromDayNumber(bussUndBettag(year)), name: 'Buß- und Bettag' })
  return sortHolidays(list)
}

/** Abwärtskompatibel: alte Signatur ('BY' | 'DE') */
export function germanHolidays(year: number, region: 'BY' | 'DE' = 'BY'): Holiday[] {
  return holidaysFor(year, region === 'BY' ? 'DE-BY' : 'DE')
}

/**
 * Nachschlagestruktur, die Jahre bei Bedarf berechnet - für die Engine, die auf
 * Tagnummern arbeitet und sehr oft `isWorkday` fragt.
 */
export class HolidayLookup {
  private readonly region: string | null
  private readonly years = new Map<number, Map<number, string>>()
  constructor(region: string | null | undefined) {
    this.region = region ?? null
  }
  get(day: number): string | null {
    if (!this.region) return null
    const year = new Date(day * 86_400_000).getUTCFullYear()
    let m = this.years.get(year)
    if (!m) {
      m = new Map()
      for (const h of holidaysFor(year, this.region)) m.set(toDayNumber(h.date), h.name)
      this.years.set(year, m)
    }
    return m.get(day) ?? null
  }
}

function sortHolidays(list: Holiday[]): Holiday[] {
  return list.sort((a, b) => a.date.localeCompare(b.date))
}

/** Mittwoch vor dem 23. November */
function bussUndBettag(year: number): number {
  let d = toDayNumber(`${year}-11-22`)
  while (weekdayOf(d) !== 3) d--
  return d
}

export function easterSunday(year: number): number {
  // Gaußsche Osterformel (Meeus/Jones/Butcher)
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000)
}
