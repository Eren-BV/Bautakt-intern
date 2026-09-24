/**
 * Export-Architektur: CSV (Excel-kompatibel, UTF-8 mit BOM, Semikolon) und
 * PDF über den Browser-Druckdialog mit Print-Stylesheet. Serverseitiges PDF-Rendering
 * kann hier später ohne UI-Änderung angeschlossen werden.
 */

export function toCsv(headers: string[], rows: string[][]): string {
  const esc = (v: string) => {
    const s = (v ?? '').replace(/"/g, '""')
    return /[;"\n\r]/.test(s) ? `"${s}"` : s
  }
  return [headers.map(esc).join(';'), ...rows.map((r) => r.map(esc).join(';'))].join('\r\n')
}

export function downloadCsv(filename: string, headers: string[], rows: string[][]): void {
  const blob = new Blob(['﻿' + toCsv(headers, rows)], { type: 'text/csv;charset=utf-8' })
  downloadBlob(filename, blob)
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function printPage(): void {
  window.print()
}
