/**
 * Zeitskala des Gantt: Tag ↔ Pixel, Kopfzeilen-Ticks je Zoomstufe.
 */

import { addMonths, fromDayNumber, isoWeek, startOfMonth, startOfWeek, toDayNumber, weekdayOf } from '../../../shared/engine/dates'

export type ViewMode = 'day' | 'week' | 'month' | 'quarter'

export const VIEW_PX: Record<ViewMode, number> = { day: 34, week: 9, month: 3, quarter: 1.15 }

export interface TimeScale {
  startDay: number
  endDay: number
  pxPerDay: number
  width: number
  x(day: number): number
  dayAt(x: number): number
}

export function buildScale(startDay: number, endDay: number, pxPerDay: number): TimeScale {
  const width = (endDay - startDay + 1) * pxPerDay
  return {
    startDay,
    endDay,
    pxPerDay,
    width,
    x: (day) => (day - startDay) * pxPerDay,
    dayAt: (x) => startDay + Math.floor(x / pxPerDay),
  }
}

export interface Tick {
  x: number
  width: number
  label: string
  key: string
  minor?: boolean
}

/** Obere und untere Kopfzeile abhängig von der Pixel-Dichte */
export function headerTicks(scale: TimeScale): { top: Tick[]; bottom: Tick[]; mode: ViewMode } {
  const { pxPerDay, startDay, endDay } = scale
  const mode: ViewMode = pxPerDay >= 20 ? 'day' : pxPerDay >= 5 ? 'week' : pxPerDay >= 2 ? 'month' : 'quarter'
  const top: Tick[] = []
  const bottom: Tick[] = []
  const monthNames = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']
  const monthLong = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']

  const pushRange = (arr: Tick[], from: number, to: number, label: string, key: string, minor?: boolean) => {
    const a = Math.max(from, startDay)
    const b = Math.min(to, endDay)
    if (b < a) return
    arr.push({ x: scale.x(a), width: (b - a + 1) * pxPerDay, label, key, minor })
  }

  if (mode === 'day') {
    // oben Monate, unten Tage
    let m = startOfMonth(fromDayNumber(startDay))
    while (toDayNumber(m) <= endDay) {
      const next = addMonths(m, 1)
      const [y, mm] = m.split('-').map(Number)
      pushRange(top, toDayNumber(m), toDayNumber(next) - 1, `${monthLong[mm - 1]} ${y}`, m)
      m = next
    }
    const dayInitials = ['S', 'M', 'D', 'M', 'D', 'F', 'S']
    for (let d = startDay; d <= endDay; d++) {
      const wd = weekdayOf(d)
      const dateNum = Number(fromDayNumber(d).slice(8, 10))
      pushRange(bottom, d, d, pxPerDay >= 28 ? `${dayInitials[wd]} ${dateNum}` : String(dateNum), String(d), wd === 0 || wd === 6)
    }
  } else if (mode === 'week') {
    let m = startOfMonth(fromDayNumber(startDay))
    while (toDayNumber(m) <= endDay) {
      const next = addMonths(m, 1)
      const [y, mm] = m.split('-').map(Number)
      pushRange(top, toDayNumber(m), toDayNumber(next) - 1, `${monthLong[mm - 1]} ${y}`, m)
      m = next
    }
    let w = toDayNumber(startOfWeek(fromDayNumber(startDay)))
    while (w <= endDay) {
      const { week } = isoWeek(fromDayNumber(w))
      pushRange(bottom, w, w + 6, pxPerDay >= 7 ? `KW ${week}` : String(week), String(w))
      w += 7
    }
  } else if (mode === 'month') {
    let y = Number(fromDayNumber(startDay).slice(0, 4))
    const endYear = Number(fromDayNumber(endDay).slice(0, 4))
    for (; y <= endYear; y++) pushRange(top, toDayNumber(`${y}-01-01`), toDayNumber(`${y}-12-31`), String(y), String(y))
    let m = startOfMonth(fromDayNumber(startDay))
    while (toDayNumber(m) <= endDay) {
      const next = addMonths(m, 1)
      const mm = Number(m.slice(5, 7))
      pushRange(bottom, toDayNumber(m), toDayNumber(next) - 1, monthNames[mm - 1], m)
      m = next
    }
  } else {
    let y = Number(fromDayNumber(startDay).slice(0, 4))
    const endYear = Number(fromDayNumber(endDay).slice(0, 4))
    for (; y <= endYear; y++) {
      pushRange(top, toDayNumber(`${y}-01-01`), toDayNumber(`${y}-12-31`), String(y), String(y))
      for (let q = 0; q < 4; q++) {
        const from = toDayNumber(`${y}-${String(q * 3 + 1).padStart(2, '0')}-01`)
        const to = toDayNumber(addMonths(`${y}-${String(q * 3 + 1).padStart(2, '0')}-01`, 3)) - 1
        pushRange(bottom, from, to, `Q${q + 1}`, `${y}q${q}`)
      }
    }
  }
  return { top, bottom, mode }
}
