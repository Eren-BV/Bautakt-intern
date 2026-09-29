/**
 * Lucid-API (API-Schlüssel des Kontos): Lucidchart-Diagramme nach Stichwort suchen und ein
 * Diagramm in einen Planentwurf übersetzen. Reiner Lesezugriff - nichts hier verändert oder
 * löscht etwas in Lucid.
 */

import { HttpError } from '../auth.ts'
import { lucidToExtractedPlan, type LucidDocumentContents } from '../../shared/integrations/lucidchart/adapter.ts'
import { normalizeExtractedPlan, type ExtractedPlan } from '../../shared/integrations/planextract/types.ts'

const LUCID_API = 'https://api.lucid.co'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** Dokument-ID aus einer Lucid-URL (lucid.app, lucidchart.com) oder direkter Eingabe lesen. */
export function parseLucidDocumentId(input: string): string | null {
  const v = input.trim()
  if (!v) return null
  // Direkte Dokument-ID
  if (new RegExp(`^${UUID.source}$`, 'i').test(v)) return v.toLowerCase()
  // Pfadform: /lucidchart/<id>/edit, /documents/edit/<id>, /documents/<id> …
  const path = v.match(new RegExp(`(?:lucidchart|documents)/(?:(?:edit|view|embeddedchart)/)?(${UUID.source})`, 'i'))
  if (path) return path[1]!.toLowerCase()
  // Sonst: erste ID vor den Query-Parametern (ignoriert z. B. invitationId)
  const beforeQuery = v.split('?')[0]!.match(UUID)
  if (beforeQuery) return beforeQuery[0].toLowerCase()
  const anywhere = v.match(UUID)
  if (anywhere) return anywhere[0].toLowerCase()
  if (/^[0-9a-z-]{16,}$/i.test(v)) return v
  return null
}

export function lucidConfigured(): boolean {
  return !!process.env['LUCIDCHART_API_KEY']
}

function requireKey(): string {
  const key = process.env['LUCIDCHART_API_KEY']
  if (!key) throw new HttpError(400, 'Für Lucidchart ist noch kein API-Schlüssel hinterlegt.')
  return key
}

/** Diagramm laden und in einen Planentwurf übersetzen - von der Route und von Jarvis genutzt. */
export async function fetchLucidPlan(documentRef: string): Promise<ExtractedPlan> {
  const key = requireKey()
  const documentId = parseLucidDocumentId(documentRef)
  if (!documentId) throw new HttpError(400, 'Bitte einen Lucidchart-Link oder eine Dokument-ID angeben.')

  const res = await fetch(`${LUCID_API}/documents/${documentId}/contents`, {
    headers: { Authorization: `Bearer ${key}`, 'Lucid-Api-Version': '1' },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) throw new HttpError(403, 'Lucidchart verweigert den Zugriff auf dieses Dokument (Schlüssel oder Freigabe prüfen).')
    if (res.status === 404) throw new HttpError(404, 'Das Lucidchart-Dokument wurde nicht gefunden.')
    throw new HttpError(502, `Lucidchart-Abruf fehlgeschlagen (${res.status}). ${text.slice(0, 200)}`)
  }
  const doc = (await res.json()) as LucidDocumentContents
  const plan = normalizeExtractedPlan(lucidToExtractedPlan(doc, documentId), { source: 'lucidchart', reference: documentId })
  if (!plan.tasks.length) throw new HttpError(422, 'Im Diagramm wurden keine beschrifteten Formen gefunden.')
  return plan
}

export interface LucidDocSummary {
  id: string
  title: string
  updated: string | null
  editUrl: string | null
}

/** Lucidchart-Diagramme nach Stichwort (Titel und Inhalt, nach Relevanz); ohne Stichwort die neuesten. */
export async function searchLucidDocuments(keywords: string, limit = 15): Promise<LucidDocSummary[]> {
  const key = requireKey()
  const body: Record<string, unknown> = { product: ['lucidchart'], excludeTrashed: true }
  if (keywords.trim()) body['keywords'] = keywords.trim().slice(0, 400)
  const res = await fetch(`${LUCID_API}/documents/search?pageSize=${Math.min(50, Math.max(1, limit))}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Lucid-Api-Version': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) throw new HttpError(403, 'Lucidchart verweigert den Zugriff (API-Schlüssel prüfen).')
    throw new HttpError(502, `Lucidchart-Suche fehlgeschlagen (${res.status}). ${text.slice(0, 200)}`)
  }
  const docs = (await res.json()) as { documentId?: string; title?: string; lastModified?: string; editUrl?: string }[]
  return docs.slice(0, limit).map((d) => ({
    id: String(d.documentId ?? ''),
    title: d.title || 'Ohne Titel',
    updated: d.lastModified ?? null,
    editUrl: d.editUrl ?? null,
  }))
}

