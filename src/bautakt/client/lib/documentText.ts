/**
 * Text aus hochgeladenen Dokumenten im Browser lesen (PDF, Word, Excel, CSV, Text/Markdown).
 * Die Bibliotheken werden erst beim tatsächlichen Upload geladen.
 */

export const SUPPORTED_DOCUMENT_TYPES = '.pdf,.docx,.doc,.xlsx,.csv,.txt,.md'

export async function extractDocumentText(file: File): Promise<string> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) return await pdfText(file)
  if (name.endsWith('.docx') || name.endsWith('.doc')) return await wordText(file)
  if (name.endsWith('.xlsx')) return await excelText(file)
  if (name.endsWith('.csv')) return await csvText(file)
  if (name.endsWith('.txt') || name.endsWith('.md')) return await file.text()
  throw new Error('Dieses Format wird nicht unterstützt. Bitte PDF, Word (.docx), Excel (.xlsx), CSV oder Text hochladen.')
}

async function pdfText(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '))
  }
  doc.cleanup()
  return pages.join('\n\n').replace(/[ \t]+/g, ' ').trim()
}

async function wordText(file: File): Promise<string> {
  const mammoth = (await import('mammoth/mammoth.browser.js')) as unknown as {
    extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>
  }
  const res = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
  return String(res.value ?? '').trim()
}

async function excelText(file: File): Promise<string> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await file.arrayBuffer())
  const sheets: string[] = []
  wb.eachSheet((sheet) => {
    const rows: string[] = []
    sheet.eachRow((row) => {
      const cells = (row.values as unknown[]).slice(1).map((v) => {
        if (v == null) return ''
        if (v instanceof Date) return v.toISOString().slice(0, 10)
        if (typeof v === 'object' && 'richText' in (v as Record<string, unknown>)) return ((v as { richText: { text: string }[] }).richText ?? []).map((r) => r.text).join('')
        if (typeof v === 'object' && 'text' in (v as Record<string, unknown>)) return String((v as { text: unknown }).text ?? '')
        if (typeof v === 'object' && 'result' in (v as Record<string, unknown>)) return String((v as { result: unknown }).result ?? '')
        return String(v)
      })
      if (cells.some((c) => c.trim())) rows.push(cells.join('\t'))
    })
    if (rows.length) sheets.push(`## ${sheet.name}\n${rows.join('\n')}`)
  })
  return sheets.join('\n\n').trim()
}

/** CSV als Text lesen: UTF-8, sonst Windows-1252 (typischer Excel-Export mit Umlauten und Semikolon). */
async function csvText(file: File): Promise<string> {
  const bytes = await file.arrayBuffer()
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes)
  }
  return text.replace(/^﻿/, '').trim()
}
