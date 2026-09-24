/**
 * KI-Analyse von Dokumenten (PDF/Word). Der Text wird im Browser aus der Datei gelesen
 * und hier an das Lovable-AI-Gateway geschickt. Ergebnis: strukturierter Plan
 * (Aufgaben, Gliederung, Abhängigkeiten, Verantwortliche) im neutralen Importformat.
 */

import { normalizeExtractedPlan, type ExtractedPlan } from '../../shared/integrations/planextract/types.ts'
import { HttpError } from '../auth.ts'

const MODEL = 'openai/gpt-6-astra'
const ENDPOINT = 'https://ai.gateway.lovable.dev/v1/responses'

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'name', 'type', 'parent_key', 'duration', 'responsible', 'notes', 'depends_on'],
  properties: {
    key: { type: 'string', description: 'Kurzer eindeutiger Schlüssel, z. B. a1' },
    name: { type: 'string' },
    type: { type: 'string', enum: ['phase', 'group', 'task', 'milestone'] },
    parent_key: { type: ['string', 'null'], description: 'Schlüssel der übergeordneten Gliederung' },
    duration: { type: ['integer', 'null'], description: 'Dauer in Arbeitstagen, Meilenstein 0' },
    responsible: { type: ['string', 'null'], description: 'Name oder E-Mail der verantwortlichen Person' },
    notes: { type: ['string', 'null'] },
    depends_on: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['predecessor_key', 'type', 'lag_days'],
        properties: {
          predecessor_key: { type: 'string' },
          type: { type: 'string', enum: ['FS', 'SS', 'FF', 'SF'] },
          lag_days: { type: 'integer' },
        },
      },
    },
  },
} as const

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'tasks', 'warnings'],
  properties: {
    name: { type: 'string', description: 'Kurzer Projekt-/Plantitel' },
    tasks: { type: 'array', items: TASK_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Unklarheiten aus dem Dokument' },
  },
} as const

const SYSTEM = `Du bist Projektplaner für ein Bau- und Architekturbüro. Du erhältst den Text eines internen Dokuments
(Protokoll, Leistungsbeschreibung, Angebot, Projektbeschreibung). Extrahiere daraus einen internen Aufgabenplan:
- Gliedere in Phasen bzw. Bereiche (type "phase"/"group") und darunter konkrete Aufgaben (type "task").
- Termine/Abnahmen/Freigaben/Abgaben werden zu Meilensteinen (type "milestone", duration 0).
- Schätze für jede Aufgabe eine realistische Dauer in Arbeitstagen, wenn keine im Text steht.
- Erkenne Reihenfolgen und Abhängigkeiten ("nach", "sobald", "Voraussetzung", "danach") und trage sie in depends_on ein.
- Personen, die im Text einer Aufgabe zugeordnet sind, kommen in responsible (Name oder E-Mail, sonst null).
- Erfinde keine Inhalte. Unklares gehört in warnings.
Antworte ausschließlich im vorgegebenen JSON-Schema, auf Deutsch.`

/** Ruft das AI-Gateway auf und liefert den strukturierten Plan. */
export async function extractPlanFromText(text: string, fileName: string, hint?: string): Promise<ExtractedPlan> {
  const key = process.env['LOVABLE_API_KEY']
  if (!key) throw new HttpError(500, 'KI ist nicht konfiguriert.')
  const clipped = text.slice(0, 120_000)
  if (clipped.trim().length < 40) throw new HttpError(400, 'Aus dem Dokument konnte kein Text gelesen werden (evtl. ein Scan ohne Textebene).')

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Lovable-API-Key': key, 'X-Lovable-AIG-SDK': 'fetch' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      instructions: SYSTEM,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Dateiname: ${fileName}\n${hint ? `Hinweis: ${hint}\n` : ''}\nDokumenttext:\n\n${clipped}`,
            },
          ],
        },
      ],
      reasoning: { effort: 'medium', summary: 'auto' },
      text: { format: { type: 'json_schema', name: 'plan', strict: true, schema: PLAN_SCHEMA } },
      store: false,
    }),
  })

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    if (res.status === 429) throw new HttpError(429, 'Die KI ist gerade ausgelastet. Bitte in einer Minute erneut versuchen.')
    if (res.status === 402) throw new HttpError(402, 'Das KI-Guthaben des Arbeitsbereichs ist aufgebraucht.')
    throw new HttpError(502, `KI-Analyse fehlgeschlagen (${res.status}). ${body.slice(0, 300)}`)
  }

  let out = ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const ev = JSON.parse(payload) as { type?: string; delta?: string; response?: { output_text?: string } }
          if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') out += ev.delta
          else if (ev.type === 'response.completed' && !out && ev.response?.output_text) out = ev.response.output_text
        } catch {
          /* unvollständiges Event */
        }
      }
    }
  }

  if (!out.trim()) throw new HttpError(502, 'Die KI hat keine verwertbare Antwort geliefert.')
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    throw new HttpError(502, 'Die KI-Antwort war kein gültiges JSON.')
  }
  const plan = normalizeExtractedPlan(parsed, { source: 'document', name: fileName.replace(/\.[a-z]+$/i, ''), reference: fileName })
  if (!plan.tasks.length) throw new HttpError(422, 'Im Dokument wurden keine Aufgaben erkannt.')
  return plan
}
