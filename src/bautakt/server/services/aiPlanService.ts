/**
 * KI-Funktionen rund um Pläne:
 *   - extractPlanFromText: Dokument (PDF/Word) → strukturierter Plan
 *   - generatePlanFromBrief: freie Beschreibung → strukturierter Plan
 *   - refinePlan: bestehenden Plan erweitern/optimieren (Anweisung in Worten)
 *   - sortPlanWithAi: Reihenfolge von Phasen und Vorgängen sinnvoll sortieren
 * Alle Aufrufe laufen über aiGateway (Lovable AI Gateway bzw. lokal OpenAI; Responses API, streaming).
 */

import { normalizeExtractedPlan, type ExtractedPlan } from '../../shared/integrations/planextract/types.ts'
import { HttpError } from '../auth.ts'
import { AI_PLAN_MODEL, aiPost, getAiProvider, modelId, readSse } from './aiGateway.ts'

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
    warnings: { type: 'array', items: { type: 'string' }, description: 'Unklarheiten oder Hinweise' },
  },
} as const

const BASE_RULES = `- Gliedere in Phasen bzw. Bereiche (type "phase"/"group") und darunter konkrete Aufgaben (type "task").
- Termine/Abnahmen/Freigaben/Abgaben werden zu Meilensteinen (type "milestone", duration 0).
- Schätze für jede Aufgabe eine realistische Dauer in Arbeitstagen, wenn keine vorgegeben ist.
- Erkenne Reihenfolgen und Abhängigkeiten ("nach", "sobald", "Voraussetzung", "danach") und trage sie in depends_on ein.
- Die Reihenfolge im tasks-Array ist die Ausführungsreihenfolge: Phasen chronologisch, Aufgaben direkt nach ihrer Phase.
- Personen, die einer Aufgabe zugeordnet sind, kommen in responsible (Name oder E-Mail, sonst null).
- Antworte ausschließlich im vorgegebenen JSON-Schema, auf Deutsch.`

const SYSTEM_DOCUMENT = `Du bist Projektplaner für interne Projekte (Organisation, Coaching, Software, Bauabwicklung).
Du erhältst den Text eines Dokuments (Protokoll, Leistungsbeschreibung, Angebot, Projektbeschreibung)
und extrahierst daraus einen Aufgabenplan.
${BASE_RULES}
- Erfinde keine Inhalte. Unklares gehört in warnings.`

const SYSTEM_BRIEF = `Du bist Projektplaner für interne Projekte (Organisation, Coaching, Software, Bauabwicklung).
Du erhältst eine kurze Beschreibung eines Vorhabens und entwirfst daraus einen vollständigen, praxistauglichen Projektplan.
${BASE_RULES}
- Ergänze fehlende, aber übliche Schritte (Vorbereitung, Abstimmung, Freigabe, Abschluss) und vermerke Annahmen in warnings.`

const SYSTEM_REFINE = `Du bist Projektplaner. Du erhältst einen bestehenden Projektplan als JSON und eine Anweisung zur Änderung.
Gib den vollständigen überarbeiteten Plan zurück – nicht nur die Änderungen.
${BASE_RULES}
- Behalte vorhandene Schlüssel (key) bestehender Vorgänge bei, damit nichts doppelt entsteht. Neue Vorgänge bekommen neue Schlüssel.
- Beschreibe in warnings kurz, was du geändert hast.`

const SYSTEM_SORT = `Du bist Projektplaner. Du erhältst einen Projektplan als JSON, dessen Reihenfolge durcheinander ist.
Gib denselben Plan unverändert zurück – nur die Reihenfolge des tasks-Arrays wird korrigiert.
- Ändere keine Namen, Schlüssel, Dauern, Typen, Verantwortlichen, Eltern-Zuordnungen oder Abhängigkeiten.
- Sortiere Phasen in der fachlich sinnvollen zeitlichen Abfolge (Anfrage → Angebot → Verhandlung → Auftrag → Planung → Vorbereitung → Ausführung → Abnahme → Rechnung → Abschluss).
- Direkt nach jeder Phase folgen ihre eigenen Vorgänge in Ausführungsreihenfolge.
- Lösche nichts und ergänze nichts. Antworte im vorgegebenen JSON-Schema.`

/** Ein Plan-Aufruf (Responses API, streaming) → geparstes JSON. `low` ist deutlich schneller (Sprachassistent). */
async function callPlanAi(system: string, userText: string, effort: 'low' | 'medium' = 'medium'): Promise<unknown> {
  const provider = getAiProvider()
  if (!provider) throw new HttpError(500, 'KI ist nicht konfiguriert.')

  const res = await aiPost('/responses', {
    model: modelId(provider, AI_PLAN_MODEL),
    stream: true,
    instructions: system,
    input: [{ role: 'user', content: [{ type: 'input_text', text: userText }] }],
    reasoning: { effort },
    text: { format: { type: 'json_schema', name: 'plan', strict: true, schema: PLAN_SCHEMA } },
    store: false,
  }, { provider })

  let out = ''
  for await (const ev of readSse(res)) {
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') out += ev.delta
    else if (ev.type === 'response.completed' && !out) {
      const text = (ev.response as { output_text?: string } | undefined)?.output_text
      if (text) out = text
    }
  }

  if (!out.trim()) throw new HttpError(502, 'Die KI hat keine verwertbare Antwort geliefert.')
  try {
    return JSON.parse(out)
  } catch {
    throw new HttpError(502, 'Die KI-Antwort war kein gültiges JSON.')
  }
}

/** Kompakte Darstellung eines Plans für den Prompt (spart Tokens gegenüber Rohdaten). */
function planToPrompt(plan: ExtractedPlan): string {
  const lines = plan.tasks.map((t) => {
    const deps = (t.depends_on ?? []).map((d) => d.predecessor_key).join(',')
    return [t.key, t.type, t.parent_key ?? '-', String(t.duration ?? 1), t.responsible ?? '-', deps || '-', t.name].join(' | ')
  })
  return `Plan: ${plan.name}\nSpalten: key | type | parent_key | duration | responsible | depends_on | name\n${lines.join('\n')}`
}

/** Dokumenttext (PDF/Word) → strukturierter Plan. */
export async function extractPlanFromText(text: string, fileName: string, hint?: string): Promise<ExtractedPlan> {
  const clipped = text.slice(0, 120_000)
  if (clipped.trim().length < 40) throw new HttpError(400, 'Aus dem Dokument konnte kein Text gelesen werden (evtl. ein Scan ohne Textebene).')
  const parsed = await callPlanAi(
    SYSTEM_DOCUMENT,
    `Dateiname: ${fileName}\n${hint ? `Hinweis: ${hint}\n` : ''}\nDokumenttext:\n\n${clipped}`,
  )
  const plan = normalizeExtractedPlan(parsed, { source: 'document', name: fileName.replace(/\.[a-z]+$/i, ''), reference: fileName })
  if (!plan.tasks.length) throw new HttpError(422, 'Im Dokument wurden keine Aufgaben erkannt.')
  return plan
}

/** Freie Beschreibung → vollständiger Planentwurf. */
export async function generatePlanFromBrief(brief: string, context?: { kind?: string; people?: string[]; effort?: 'low' | 'medium' }): Promise<ExtractedPlan> {
  const text = brief.trim()
  if (text.length < 10) throw new HttpError(400, 'Bitte beschreibe das Vorhaben etwas ausführlicher.')
  const people = context?.people?.length ? `\nVerfügbare Personen (nur diese als responsible verwenden): ${context.people.join(', ')}` : ''
  const kind = context?.kind ? `\nArt des Vorhabens: ${context.kind}` : ''
  const parsed = await callPlanAi(SYSTEM_BRIEF, `Beschreibung des Vorhabens:${kind}${people}\n\n${text.slice(0, 20_000)}`, context?.effort)
  const plan = normalizeExtractedPlan(parsed, { source: 'document', name: 'KI-Projektplan', reference: 'KI-Entwurf' })
  if (!plan.tasks.length) throw new HttpError(422, 'Die KI konnte aus der Beschreibung keinen Plan ableiten.')
  return plan
}

/** Bestehenden Plan nach Anweisung erweitern oder optimieren. */
export async function refinePlan(plan: ExtractedPlan, instruction: string, people?: string[]): Promise<ExtractedPlan> {
  const task = instruction.trim()
  if (!task) throw new HttpError(400, 'Bitte beschreibe, was geändert werden soll.')
  const peopleLine = people?.length ? `\nVerfügbare Personen (nur diese als responsible verwenden): ${people.join(', ')}` : ''
  const parsed = await callPlanAi(SYSTEM_REFINE, `Anweisung: ${task}${peopleLine}\n\nBestehender Plan:\n${planToPrompt(plan)}`)
  const next = normalizeExtractedPlan(parsed, { source: plan.source, name: plan.name, reference: plan.reference })
  if (!next.tasks.length) throw new HttpError(422, 'Die KI hat keinen verwertbaren Plan zurückgegeben.')
  return next
}

/** Reihenfolge eines Plans sinnvoll sortieren (Inhalte bleiben unverändert). */
export async function sortPlanWithAi(plan: ExtractedPlan): Promise<ExtractedPlan> {
  if (plan.tasks.length < 2) return plan
  const parsed = await callPlanAi(SYSTEM_SORT, planToPrompt(plan))
  const sorted = normalizeExtractedPlan(parsed, { source: plan.source, name: plan.name, reference: plan.reference })

  // Sicherheitsnetz: nur die Reihenfolge übernehmen, Inhalte bleiben die Originale.
  const byKey = new Map(plan.tasks.map((t) => [t.key, t]))
  const out: typeof plan.tasks = []
  const used = new Set<string>()
  for (const t of sorted.tasks) {
    const original = byKey.get(t.key)
    if (original && !used.has(t.key)) {
      used.add(t.key)
      out.push(original)
    }
  }
  for (const t of plan.tasks) if (!used.has(t.key)) out.push(t)
  return { ...plan, tasks: out, warnings: [...(plan.warnings ?? []), 'Die Reihenfolge wurde von der KI sortiert – bitte prüfen.'] }
}
