/**
 * Einheitlicher Zugang zu den KI-Modellen. In Lovable läuft alles über das AI Gateway
 * (LOVABLE_API_KEY wird dort automatisch gesetzt), lokal direkt über OpenAI (OPENAI_API_KEY in
 * .env.local). Beide sprechen dasselbe Format (Responses API, Audio-Endpunkte).
 */

import { HttpError } from '../auth.ts'

export interface AiProvider {
  kind: 'lovable' | 'openai'
  baseUrl: string
  headers: Record<string, string>
}

export const AI_PLAN_MODEL = process.env['AI_PLAN_MODEL'] || 'openai/gpt-6-astra'

export function getAiProvider(): AiProvider | null {
  const forced = process.env['AI_PROVIDER']
  const lovableKey = process.env['LOVABLE_API_KEY']
  const openaiKey = process.env['OPENAI_API_KEY']
  if (lovableKey && forced !== 'openai') {
    return { kind: 'lovable', baseUrl: 'https://ai.gateway.lovable.dev/v1', headers: { 'Lovable-API-Key': lovableKey, 'X-Lovable-AIG-SDK': 'fetch' } }
  }
  if (openaiKey && forced !== 'lovable') {
    const baseUrl = (process.env['OPENAI_BASE_URL'] || 'https://api.openai.com/v1').replace(/\/$/, '')
    return { kind: 'openai', baseUrl, headers: { Authorization: `Bearer ${openaiKey}` } }
  }
  return null
}

export function requireAiProvider(): AiProvider {
  const provider = getAiProvider()
  if (!provider) throw new HttpError(503, 'KI ist nicht konfiguriert.')
  return provider
}

/** Das Gateway erwartet „anbieter/modell“, OpenAI direkt nur den Modellnamen. */
export function modelId(provider: AiProvider, id: string): string {
  if (provider.kind === 'lovable') return id
  if (id.startsWith('openai/')) return id.slice('openai/'.length)
  if (id.includes('/')) throw new HttpError(500, `Das Modell „${id}“ ist lokal nicht verfügbar – lokal werden nur OpenAI-Modelle unterstützt.`)
  return id
}

export async function aiPost(path: string, body: unknown, opts: { provider?: AiProvider; signal?: AbortSignal } = {}): Promise<Response> {
  const provider = opts.provider ?? requireAiProvider()
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData
  const res = await fetch(`${provider.baseUrl}${path}`, {
    method: 'POST',
    headers: isForm ? provider.headers : { ...provider.headers, 'Content-Type': 'application/json' },
    body: isForm ? body : JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok) throw aiError(res.status, await res.text().catch(() => ''))
  return res
}

export function aiError(status: number, body: string): HttpError {
  if (status === 429) return new HttpError(429, 'Die KI ist gerade ausgelastet. Bitte in einer Minute erneut versuchen.')
  if (status === 402) return new HttpError(402, 'Das KI-Guthaben des Arbeitsbereichs ist aufgebraucht.')
  if (status === 403) return new HttpError(403, 'Die KI hat diese Anfrage abgelehnt.')
  if ((status === 400 || status === 404) && /model/i.test(body)) return new HttpError(502, `Das KI-Modell ist nicht verfügbar. ${body.slice(0, 200)}`)
  return new HttpError(502, `KI-Anfrage fehlgeschlagen (${status}). ${body.slice(0, 300)}`)
}

/** Liest einen Server-Sent-Events-Stream als Folge geparster JSON-Events. */
export async function* readSse(res: Response): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\r?\n\r?\n/)
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const data = part
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
      if (!data || data === '[DONE]') continue
      try {
        yield JSON.parse(data) as Record<string, unknown>
      } catch {
        /* unvollständiges Event */
      }
    }
  }
}
