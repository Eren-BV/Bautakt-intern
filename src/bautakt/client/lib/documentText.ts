/**
 * Text aus hochgeladenen Dokumenten im Browser lesen (PDF, Word, Text/Markdown).
 * Die Bibliotheken werden erst beim tatsächlichen Upload geladen.
 */

export const SUPPORTED_DOCUMENT_TYPES = '.pdf,.docx,.doc,.txt,.md'

export async function extractDocumentText(file: File): Promise<string> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) return await pdfText(file)
  if (name.endsWith('.docx') || name.endsWith('.doc')) return await wordText(file)
  if (name.endsWith('.txt') || name.endsWith('.md')) return await file.text()
  throw new Error('Dieses Format wird nicht unterstützt. Bitte PDF, Word (.docx) oder Text hochladen.')
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
  await doc.destroy()
  return pages.join('\n\n').replace(/[ \t]+/g, ' ').trim()
}

async function wordText(file: File): Promise<string> {
  const mammoth = await import('mammoth/mammoth.browser.js')
  const res = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
  return String(res.value ?? '').trim()
}
