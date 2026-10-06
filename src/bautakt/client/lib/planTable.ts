/**
 * Excel/CSV als Tabelle lesen und, wenn sie wie ein Plan aussieht (Spalten wie Vorgang/Name,
 * Dauer, Vorgänger, Ebene), direkt ohne KI in einen Planentwurf übersetzen.
 */

import type { ExtractedPlan } from '../../shared/integrations/planextract/types'
import { findPlanTable, tableToExtractedPlan, type Table } from '../../shared/integrations/planextract/table'
import { parseCsv } from '../../shared/import/pipeline'

function cellText(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('')
    if ('text' in o) return String(o.text ?? '')
    if ('result' in o) return cellText(o.result)
  }
  return String(v)
}

async function csvTable(file: File): Promise<Table> {
  const bytes = await file.arrayBuffer()
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes)
  }
  const parsed = parseCsv(text)
  return [parsed.headers, ...parsed.rows]
}

async function xlsxTables(file: File): Promise<Table[]> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await file.arrayBuffer())
  const tables: Table[] = []
  wb.eachSheet((sheet) => {
    const rows: Table = []
    sheet.eachRow((row) => {
      const cells = (row.values as unknown[]).slice(1).map(cellText)
      if (cells.some((c) => c.trim())) rows.push(cells)
    })
    tables.push(rows)
  })
  return tables
}

/** Planentwurf direkt aus einer Plantabelle (Excel/CSV); null, wenn die Datei keine solche Tabelle enthält. */
export async function extractPlanFromTable(file: File): Promise<ExtractedPlan | null> {
  const lower = file.name.toLowerCase()
  const name = file.name.replace(/\.[a-z0-9]+$/i, '')
  if (lower.endsWith('.csv')) return tableToExtractedPlan(await csvTable(file), name, file.name)
  if (lower.endsWith('.xlsx')) {
    const tables = (await xlsxTables(file)).filter((t) => findPlanTable(t))
    const biggest = tables.sort((a, b) => b.length - a.length)[0]
    return biggest ? tableToExtractedPlan(biggest, name, file.name) : null
  }
  return null
}
