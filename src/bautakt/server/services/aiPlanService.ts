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
- Abhängigkeiten (depends_on) sind der wichtigste Teil deiner Arbeit - nimm dir dafür besondere Sorgfalt:
  - Prüfe JEDE Aufgabe einzeln: Was muss zwingend vorher fertig sein, bevor diese beginnen kann? Trage das als depends_on ein, auch wenn es nicht wörtlich im Text steht, sondern sich aus der Fachlogik ergibt (z. B. "Testen" setzt "Entwickeln" voraus, "Freigabe" setzt "Vorlage einreichen" voraus).
  - Sprachliche Signale ("nach", "sobald", "erst wenn", "Voraussetzung", "im Anschluss", "danach", "bevor") IMMER in eine Abhängigkeit übersetzen - nie nur in die Reihenfolge des Arrays, sondern explizit in depends_on.
  - Unterscheide bewusst: Aufgaben OHNE echte inhaltliche Abhängigkeit voneinander (z. B. zwei verschiedene Teams bereiten unabhängig etwas vor) bekommen KEINE künstliche Abhängigkeit - sie dürfen parallel laufen. Erfinde keine Abhängigkeit nur um eine Reihenfolge zu erzwingen.
  - type FS (Ende→Start, Standard) heißt: Vorgänger muss fertig sein. SS (Start→Start) heißt: darf gleichzeitig beginnen. Wähle bewusst, nicht immer FS.
  - Innerhalb einer Phase: aufeinanderfolgende Schritte bekommen eine Kette von Abhängigkeiten (Schritt 2 hängt von Schritt 1 ab, Schritt 3 von Schritt 2 usw.), nicht nur alle von der Phase selbst.
  - Zwischen Phasen: hängt die erste Aufgabe einer Phase inhaltlich vom Abschluss der vorigen Phase ab, trage das ausdrücklich ein.
- Die Reihenfolge im tasks-Array ist die Ausführungsreihenfolge: Phasen chronologisch, Aufgaben direkt nach ihrer Phase. Diese Reihenfolge UND depends_on müssen zueinander passen - ein Vorgänger steht nie nach seinem Nachfolger im Array.
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

export type PlanAiProgress = { type: 'progress'; tasks: number } | { type: 'done'; parsed: unknown }

/**
 * Ein Plan-Aufruf (Responses API, streaming). Gibt zwischendurch aus, wie viele Aufgaben im
 * bisher angekommenen Text schon vollständig auftauchen (an der Anzahl "key"-Felder erkennbar) -
 * die Antwort ist erst am Ende gültiges JSON, aber die Aufgaben erscheinen der Reihe nach.
 * `low` ist deutlich schneller (Sprachassistent), `medium` für einmalige Ersterstellung aus
 * einem Dokument/einer Beschreibung, wo Sorgfalt (v. a. bei Abhängigkeiten) wichtiger ist als Tempo.
 */
async function* streamPlanAi(system: string, userText: string, effort: 'low' | 'medium' = 'medium'): AsyncGenerator<PlanAiProgress> {
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
    // Ohne Obergrenze kann ein Reasoning-Modell lange (oft über eine Minute) an internen
    // Denkschritten hängen, bevor überhaupt die erste JSON-Zeile kommt - Jarvis ist ein
    // Sprachassistent, da zählt jede Sekunde. 8000 Tokens reichen für einen sehr großen Plan.
    max_output_tokens: 8000,
  }, { provider })

  let out = ''
  let incomplete = false
  let lastCount = 0
  for await (const ev of readSse(res)) {
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      out += ev.delta
      const count = (out.match(/"key"\s*:\s*"/g) ?? []).length
      if (count > lastCount) {
        lastCount = count
        yield { type: 'progress', tasks: count }
      }
    } else if (ev.type === 'response.completed' && !out) {
      const text = (ev.response as { output_text?: string } | undefined)?.output_text
      if (text) out = text
    } else if (ev.type === 'response.incomplete') incomplete = true
  }

  if (!out.trim()) throw new HttpError(502, 'Die KI hat keine verwertbare Antwort geliefert.')
  try {
    yield { type: 'done', parsed: JSON.parse(out) }
  } catch {
    if (incomplete) throw new HttpError(502, 'Der Plan wurde zu umfangreich und ist abgeschnitten – bitte in kleineren Abschnitten planen.')
    throw new HttpError(502, 'Die KI-Antwort war kein gültiges JSON.')
  }
}

/** Wie streamPlanAi, aber ohne Zwischenstand - für Aufrufer, die nur das Ergebnis brauchen. */
async function callPlanAi(system: string, userText: string, effort: 'low' | 'medium' = 'medium'): Promise<unknown> {
  for await (const ev of streamPlanAi(system, userText, effort)) if (ev.type === 'done') return ev.parsed
  throw new HttpError(502, 'Die KI hat keine verwertbare Antwort geliefert.')
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
  let plan: ExtractedPlan | null = null
  for await (const ev of extractPlanFromTextStream(text, fileName, hint)) if (ev.type === 'done') plan = ev.plan
  if (!plan) throw new HttpError(502, 'Die KI hat keine verwertbare Antwort geliefert.')
  return plan
}

/** Wie extractPlanFromText, meldet zwischendurch die Anzahl bereits entworfener Aufgaben. */
export async function* extractPlanFromTextStream(text: string, fileName: string, hint?: string): AsyncGenerator<{ type: 'progress'; tasks: number } | { type: 'done'; plan: ExtractedPlan }> {
  const clipped = text.slice(0, 120_000)
  if (clipped.trim().length < 40) throw new HttpError(400, 'Aus dem Dokument konnte kein Text gelesen werden (evtl. ein Scan ohne Textebene).')
  let parsed: unknown = null
  for await (const ev of streamPlanAi(SYSTEM_DOCUMENT, `Dateiname: ${fileName}\n${hint ? `Hinweis: ${hint}\n` : ''}\nDokumenttext:\n\n${clipped}`, 'medium')) {
    if (ev.type === 'progress') yield ev
    else parsed = ev.parsed
  }
  const plan = normalizeExtractedPlan(parsed, { source: 'document', name: fileName.replace(/\.[a-z]+$/i, ''), reference: fileName })
  if (!plan.tasks.length) throw new HttpError(422, 'Im Dokument wurden keine Aufgaben erkannt.')
  yield { type: 'done', plan }
}

/** Freie Beschreibung → vollständiger Planentwurf. */
export async function generatePlanFromBrief(brief: string, context?: { kind?: string; people?: string[]; effort?: 'low' | 'medium' }): Promise<ExtractedPlan> {
  let plan: ExtractedPlan | null = null
  for await (const ev of generatePlanFromBriefStream(brief, context)) if (ev.type === 'done') plan = ev.plan
  if (!plan) throw new HttpError(502, 'Die KI hat keine verwertbare Antwort geliefert.')
  return plan
}

/** Wie generatePlanFromBrief, meldet zwischendurch die Anzahl bereits entworfener Aufgaben. */
export async function* generatePlanFromBriefStream(brief: string, context?: { kind?: string; people?: string[]; effort?: 'low' | 'medium' }): AsyncGenerator<{ type: 'progress'; tasks: number } | { type: 'done'; plan: ExtractedPlan }> {
  const text = brief.trim()
  if (text.length < 10) throw new HttpError(400, 'Bitte beschreibe das Vorhaben etwas ausführlicher.')
  const people = context?.people?.length ? `\nVerfügbare Personen (nur diese als responsible verwenden): ${context.people.join(', ')}` : ''
  const kind = context?.kind ? `\nArt des Vorhabens: ${context.kind}` : ''
  let parsed: unknown = null
  for await (const ev of streamPlanAi(SYSTEM_BRIEF, `Beschreibung des Vorhabens:${kind}${people}\n\n${text.slice(0, 20_000)}`, context?.effort ?? 'medium')) {
    if (ev.type === 'progress') yield ev
    else parsed = ev.parsed
  }
  const plan = normalizeExtractedPlan(parsed, { source: 'document', name: 'KI-Projektplan', reference: 'KI-Entwurf' })
  if (!plan.tasks.length) throw new HttpError(422, 'Die KI konnte aus der Beschreibung keinen Plan ableiten.')
  yield { type: 'done', plan }
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
