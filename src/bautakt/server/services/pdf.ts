/**
 * Echte PDF-Berichte mit pdf-lib (kein Browser-Druck): kleiner Layout-Helfer für Kopf/Fuß,
 * Text, Tabellen mit Seitenumbruch und Gantt-Balken. Standardschriften (Helvetica, WinAnsi)
 * decken Umlaute ab; Sonderzeichen werden ersetzt.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import { formatDate, fromDayNumber, toDayNumber, todayISO, startOfMonth, addMonths, isoWeek, startOfWeek } from '../../shared/engine/dates.ts'

export const C = {
  ink: rgb(0.08, 0.09, 0.11),
  soft: rgb(0.32, 0.35, 0.4),
  faint: rgb(0.55, 0.58, 0.63),
  line: rgb(0.85, 0.87, 0.9),
  bg: rgb(0.96, 0.97, 0.98),
  brand: rgb(0.14, 0.33, 0.84),
  ok: rgb(0.09, 0.64, 0.29),
  warn: rgb(0.85, 0.47, 0.02),
  danger: rgb(0.86, 0.15, 0.15),
  milestone: rgb(0.12, 0.16, 0.23),
  baseline: rgb(0.73, 0.75, 0.8),
}

export function sanitize(s: string): string {
  return String(s ?? '')
    .replace(/[◆◇]/g, '•')
    .replace(/→/g, '->')
    .replace(/[→✓✔]/g, '+')
    .replace(/[^\x20-\x7E\xA0-\xFF€–—„“”‘’•…]/g, '?')
}

export function hexToRgb(hex: string): RGB {
  const m = hex.replace('#', '')
  const n = parseInt(m.length === 3 ? m.split('').map((c) => c + c).join('') : m, 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

export interface Column {
  label: string
  width: number
  align?: 'left' | 'right'
  bold?: boolean
}

export class PdfDoc {
  doc!: PDFDocument
  font!: PDFFont
  bold!: PDFFont
  page!: PDFPage
  y = 0
  readonly margin = 40
  readonly landscape: boolean
  readonly title: string
  readonly subtitle: string
  readonly org: string
  pageNo = 0

  constructor(opts: { title: string; subtitle?: string; org: string; landscape?: boolean }) {
    this.title = opts.title
    this.subtitle = opts.subtitle ?? ''
    this.org = opts.org
    this.landscape = !!opts.landscape
  }

  static async create(opts: ConstructorParameters<typeof PdfDoc>[0]): Promise<PdfDoc> {
    const d = new PdfDoc(opts)
    d.doc = await PDFDocument.create()
    d.doc.setTitle(opts.title)
    d.doc.setProducer('BauTakt')
    d.doc.setCreator('BauTakt')
    d.font = await d.doc.embedFont(StandardFonts.Helvetica)
    d.bold = await d.doc.embedFont(StandardFonts.HelveticaBold)
    d.addPage()
    return d
  }

  get width() {
    return this.page.getWidth()
  }
  get contentWidth() {
    return this.width - 2 * this.margin
  }
  get bottom() {
    return this.margin + 28
  }

  addPage() {
    this.pageNo++
    this.page = this.doc.addPage(this.landscape ? [841.89, 595.28] : [595.28, 841.89])
    const h = this.page.getHeight()
    // Kopf
    this.page.drawRectangle({ x: this.margin, y: h - 46, width: 22, height: 22, color: C.brand })
    this.page.drawText('BT', { x: this.margin + 4, y: h - 40, size: 10, font: this.bold, color: rgb(1, 1, 1) })
    this.page.drawText(sanitize(this.org), { x: this.margin + 30, y: h - 34, size: 9, font: this.bold, color: C.ink })
    this.page.drawText(sanitize(this.title), { x: this.margin + 30, y: h - 45, size: 8, font: this.font, color: C.soft })
    const stamp = `Stand ${formatDate(todayISO())}`
    this.page.drawText(stamp, { x: this.width - this.margin - this.font.widthOfTextAtSize(stamp, 8), y: h - 36, size: 8, font: this.font, color: C.faint })
    this.page.drawLine({ start: { x: this.margin, y: h - 56 }, end: { x: this.width - this.margin, y: h - 56 }, thickness: 0.6, color: C.line })
    // Fuß
    const foot = `BauTakt · ${sanitize(this.title)} · Seite ${this.pageNo}`
    this.page.drawText(foot, { x: this.margin, y: this.margin - 10, size: 7.5, font: this.font, color: C.faint })
    this.y = h - 72
  }

  ensure(height: number) {
    if (this.y - height < this.bottom) this.addPage()
  }

  h1(text: string) {
    this.ensure(30)
    this.page.drawText(sanitize(text), { x: this.margin, y: this.y - 16, size: 18, font: this.bold, color: C.ink })
    this.y -= 26
  }
  h2(text: string) {
    this.ensure(28)
    this.y -= 8
    this.page.drawText(sanitize(text), { x: this.margin, y: this.y - 12, size: 12, font: this.bold, color: C.ink })
    this.y -= 20
  }
  text(text: string, opts: { size?: number; color?: RGB; bold?: boolean; indent?: number } = {}) {
    const size = opts.size ?? 9.5
    const font = opts.bold ? this.bold : this.font
    const maxW = this.contentWidth - (opts.indent ?? 0)
    for (const line of wrap(sanitize(text), font, size, maxW)) {
      this.ensure(size + 5)
      this.page.drawText(line, { x: this.margin + (opts.indent ?? 0), y: this.y - size, size, font, color: opts.color ?? C.ink })
      this.y -= size + 4
    }
  }
  kv(pairs: [string, string][], cols = 3) {
    const colW = this.contentWidth / cols
    const rows = Math.ceil(pairs.length / cols)
    this.ensure(rows * 30 + 6)
    pairs.forEach((p, i) => {
      const cx = this.margin + (i % cols) * colW
      const cy = this.y - Math.floor(i / cols) * 30
      this.page.drawText(sanitize(p[0]).toUpperCase(), { x: cx, y: cy - 9, size: 6.5, font: this.font, color: C.faint })
      this.page.drawText(sanitize(p[1]), { x: cx, y: cy - 22, size: 11, font: this.bold, color: C.ink })
    })
    this.y -= rows * 30 + 6
  }
  bullet(text: string, color = C.ink) {
    this.ensure(14)
    this.page.drawCircle({ x: this.margin + 4, y: this.y - 7, size: 1.6, color })
    const lines = wrap(sanitize(text), this.font, 9, this.contentWidth - 14)
    lines.forEach((l, i) => {
      if (i > 0) this.ensure(13)
      this.page.drawText(l, { x: this.margin + 12, y: this.y - 10, size: 9, font: this.font, color: C.ink })
      this.y -= 13
    })
  }

  table(columns: Column[], rows: (string | { text: string; color?: RGB; bold?: boolean })[][], opts: { rowHeight?: number; zebra?: boolean; fontSize?: number } = {}) {
    const rh = opts.rowHeight ?? 16
    const fs = opts.fontSize ?? 8
    const total = columns.reduce((s, c) => s + c.width, 0)
    const scale = total > this.contentWidth ? this.contentWidth / total : 1
    const widths = columns.map((c) => c.width * scale)
    const header = () => {
      this.ensure(rh + 4)
      this.page.drawRectangle({ x: this.margin, y: this.y - rh, width: this.contentWidth, height: rh, color: C.bg })
      let x = this.margin
      columns.forEach((c, i) => {
        const label = sanitize(c.label).toUpperCase()
        const w = this.bold.widthOfTextAtSize(label, 6.5)
        this.page.drawText(label, { x: c.align === 'right' ? x + widths[i] - 4 - w : x + 4, y: this.y - rh + 5, size: 6.5, font: this.bold, color: C.soft })
        x += widths[i]
      })
      this.y -= rh
    }
    header()
    rows.forEach((row, ri) => {
      if (this.y - rh < this.bottom) {
        this.addPage()
        header()
      }
      if (opts.zebra !== false && ri % 2 === 1) this.page.drawRectangle({ x: this.margin, y: this.y - rh, width: this.contentWidth, height: rh, color: rgb(0.985, 0.987, 0.99) })
      this.page.drawLine({ start: { x: this.margin, y: this.y - rh }, end: { x: this.margin + this.contentWidth, y: this.y - rh }, thickness: 0.4, color: C.line })
      let x = this.margin
      row.forEach((cell, i) => {
        const c = typeof cell === 'string' ? { text: cell } : cell
        const font = c.bold || columns[i].bold ? this.bold : this.font
        const txt = truncate(sanitize(c.text), font, fs, widths[i] - 8)
        const w = font.widthOfTextAtSize(txt, fs)
        this.page.drawText(txt, { x: columns[i].align === 'right' ? x + widths[i] - 4 - w : x + 4, y: this.y - rh + 5, size: fs, font, color: c.color ?? C.ink })
        x += widths[i]
      })
      this.y -= rh
    })
    this.y -= 6
  }

  /**
   * Gantt: links Tabellenspalten, rechts Balken je Zeile. Zeitachse Wochen/Monate.
   */
  gantt(
    rows: { cells: string[]; depth: number; isParent: boolean; isMilestone: boolean; start: string; end: string; progress: number; color: RGB; critical: boolean; baseline?: { start: string; end: string } | null; done: boolean }[],
    columns: Column[],
    range: { start: string; end: string },
    today = todayISO(),
  ) {
    const rh = 14
    const leftW = columns.reduce((s, c) => s + c.width, 0)
    const tlX = this.margin + leftW + 6
    const tlW = this.contentWidth - leftW - 6
    const d0 = toDayNumber(range.start) - 3
    const d1 = toDayNumber(range.end) + 7
    const px = tlW / Math.max(1, d1 - d0)
    const x = (iso: string) => tlX + (toDayNumber(iso) - d0) * px
    const header = () => {
      this.ensure(rh * 2 + 10)
      const top = this.y
      this.page.drawRectangle({ x: this.margin, y: top - 2 * rh, width: this.contentWidth, height: 2 * rh, color: C.bg })
      let cx = this.margin
      columns.forEach((c) => {
        this.page.drawText(sanitize(c.label).toUpperCase(), { x: cx + 3, y: top - 2 * rh + 5, size: 6, font: this.bold, color: C.soft })
        cx += c.width
      })
      // Monate oben, Wochen unten
      let m = startOfMonth(fromDayNumber(d0))
      while (toDayNumber(m) <= d1) {
        const nx = addMonths(m, 1)
        const mx = Math.max(tlX, x(m))
        const mw = Math.min(tlX + tlW, x(nx)) - mx
        if (mw > 18) this.page.drawText(sanitize(monthLabel(m)), { x: mx + 2, y: top - rh + 4, size: 6.5, font: this.bold, color: C.soft })
        this.page.drawLine({ start: { x: mx, y: top - 2 * rh }, end: { x: mx, y: top }, thickness: 0.4, color: C.line })
        m = nx
      }
      if (px * 7 >= 14) {
        let w = toDayNumber(startOfWeek(fromDayNumber(d0)))
        while (w <= d1) {
          const wx = x(fromDayNumber(w))
          if (wx >= tlX) this.page.drawText(String(isoWeek(fromDayNumber(w)).week), { x: wx + 1.5, y: top - 2 * rh + 4, size: 5.5, font: this.font, color: C.faint })
          w += 7
        }
      }
      this.y = top - 2 * rh
    }
    header()
    const todayX = x(today)
    for (const r of rows) {
      if (this.y - rh < this.bottom) {
        this.addPage()
        header()
      }
      const yTop = this.y
      const cy = yTop - rh / 2
      this.page.drawLine({ start: { x: this.margin, y: yTop - rh }, end: { x: this.margin + this.contentWidth, y: yTop - rh }, thickness: 0.3, color: C.line })
      let cx = this.margin
      r.cells.forEach((cell, i) => {
        const font = i === 0 && r.isParent ? this.bold : this.font
        const indent = i === 0 ? r.depth * 7 : 0
        const txt = truncate(sanitize(cell), font, 6.8, columns[i].width - 6 - indent)
        const w = font.widthOfTextAtSize(txt, 6.8)
        this.page.drawText(txt, { x: columns[i].align === 'right' ? cx + columns[i].width - 3 - w : cx + 3 + indent, y: yTop - rh + 4, size: 6.8, font, color: r.done ? C.faint : C.ink })
        cx += columns[i].width
      })
      if (todayX >= tlX && todayX <= tlX + tlW) this.page.drawLine({ start: { x: todayX, y: yTop - rh }, end: { x: todayX, y: yTop }, thickness: 0.6, color: C.danger, dashArray: [2, 2] })
      if (r.baseline) {
        const bx1 = x(r.baseline.start), bx2 = x(r.baseline.end) + px
        this.page.drawRectangle({ x: bx1, y: cy - 5.5, width: Math.max(1, bx2 - bx1), height: 2, color: C.baseline })
      }
      const x1 = x(r.start), x2 = x(r.end) + px
      if (r.isMilestone) {
        const mx = x1 + px / 2
        this.page.drawSvgPath(`M ${mx} ${cy + 4} L ${mx + 4} ${cy} L ${mx} ${cy - 4} L ${mx - 4} ${cy} Z`, { x: 0, y: 0, color: r.done ? C.ok : r.critical ? C.danger : C.milestone })
        this.page.drawText(truncate(sanitize(r.cells[0]), this.font, 6, tlX + tlW - mx - 8), { x: mx + 7, y: cy - 2, size: 6, font: this.font, color: C.soft })
      } else if (r.isParent) {
        this.page.drawRectangle({ x: x1, y: cy - 1.5, width: Math.max(1.5, x2 - x1), height: 3.5, color: r.critical ? C.danger : C.milestone })
      } else {
        const w = Math.max(1.5, x2 - x1)
        this.page.drawRectangle({ x: x1, y: cy - 4, width: w, height: 8, color: r.done ? C.baseline : r.color, borderColor: r.critical ? C.danger : undefined, borderWidth: r.critical ? 0.8 : 0 })
        if (r.progress > 0) this.page.drawRectangle({ x: x1, y: cy - 4, width: (w * Math.min(100, r.progress)) / 100, height: 8, color: rgb(0, 0, 0), opacity: 0.25 })
      }
      this.y -= rh
    }
    this.y -= 6
  }

  async bytes(): Promise<Uint8Array> {
    return this.doc.save()
  }
}

function monthLabel(iso: string): string {
  const names = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']
  const [y, m] = iso.split('-').map(Number)
  return `${names[m - 1]} ${String(y).slice(2)}`
}

function truncate(text: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text
  let t = text
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxW) t = t.slice(0, -1)
  return t + '…'
}

function wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(' ')
    let line = ''
    for (const w of words) {
      const test = line ? `${line} ${w}` : w
      if (font.widthOfTextAtSize(test, size) > maxW && line) {
        out.push(line)
        line = w
      } else line = test
    }
    out.push(line)
  }
  return out
}
