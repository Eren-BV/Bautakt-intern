/**
 * Datumsarithmetik ohne Zeitzonen-Fallen: intern rechnet die Engine mit "Tagnummern"
 * (ganze Tage seit 1970-01-01 UTC). ISO-Strings werden nur an den Rändern konvertiert.
 */

import type { ISODate } from '../types.ts'

const MS_PER_DAY = 86_400_000

export function toDayNumber(iso: ISODate): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY)
}

export function fromDayNumber(day: number): ISODate {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

/** 0 = Sonntag … 6 = Samstag (wie JS `getUTCDay`) */
export function weekdayOf(day: number): number {
  return ((day + 4) % 7 + 7) % 7
}

export function addDays(iso: ISODate, n: number): ISODate {
  return fromDayNumber(toDayNumber(iso) + n)
}

export function diffDays(a: ISODate, b: ISODate): number {
  return toDayNumber(b) - toDayNumber(a)
}

export function todayISO(now: Date = new Date()): ISODate {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a <= b ? a : b
}

/** ISO-Kalenderwoche (Montag als Wochenstart) */
export function isoWeek(iso: ISODate): { year: number; week: number } {
  const day = toDayNumber(iso)
  const wd = weekdayOf(day) || 7 // Mo=1 … So=7
  const thursday = day + (4 - wd)
  const thursdayDate = new Date(thursday * MS_PER_DAY)
  const year = thursdayDate.getUTCFullYear()
  const jan1 = Math.round(Date.UTC(year, 0, 1) / MS_PER_DAY)
  const week = Math.floor((thursday - jan1) / 7) + 1
  return { year, week }
}

/** Montag der Woche, in der `iso` liegt */
export function startOfWeek(iso: ISODate): ISODate {
  const day = toDayNumber(iso)
  const wd = weekdayOf(day) || 7
  return fromDayNumber(day - (wd - 1))
}

export function startOfMonth(iso: ISODate): ISODate {
  return iso.slice(0, 8) + '01'
}

export function addMonths(iso: ISODate, n: number): ISODate {
  const [y, m] = iso.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}-01`
}

export function formatDate(iso: ISODate | null | undefined, style: 'short' | 'long' | 'numeric' = 'numeric'): string {
  if (!iso) return '–'
  const [y, m, d] = iso.split('-').map(Number)
  if (style === 'numeric') return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`
  if (style === 'short') return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`
  const months = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']
  return `${d}. ${months[m - 1]} ${y}`
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return `${formatDate(todayISO(d))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Feiertage: siehe holidays.ts (Re-Export fuer bestehende Importe) */
export { germanHolidays } from './holidays.ts'
