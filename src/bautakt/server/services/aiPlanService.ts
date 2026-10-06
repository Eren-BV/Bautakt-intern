/**
 * KI-Funktionen rund um Pläne:
 *   - extractPlanFromText: Dokument (PDF/Word) → strukturierter Plan
 *   - generatePlanFromBrief: freie Beschreibung → strukturierter Plan
 *   - refinePlan: bestehenden Plan erweitern/optimieren (Anweisung in Worten)
 *   - sortPlanWithAi: Reihenfolge von Phasen und Vorgängen sinnvoll sortieren
 * Alle Aufrufe laufen über aiGateway (Lovable AI Gateway bzw. lokal OpenAI; Responses API, streaming).
 */

import { normalizeExtractedPlan, type ExtractedPlan, type ExtractedTask } from '../../shared/integrations/planextract/types.ts'
import { HttpError } from '../auth.ts'
import { AI_PLAN_MODEL, aiPost, getAiProvider, modelId, readSse } from './aiGateway.ts'

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'name', 'source_excerpt', 'type', 'parent_key', 'duration', 'responsible', 'notes', 'depends_on'],
  properties: {
    key: { type: 'string', description: 'Kurzer eindeutiger Schlüssel, z. B. a1' },
    name: {
      type: 'string',
      description:
        'Bei type "task": nah an der tatsächlichen Formulierung aus dem Quelltext bleiben, nicht in eigene Fachbegriffe abstrahieren oder umbenennen - wenn dort "Fenster bestellen" steht, nicht zu "Beschaffung der Fensterelemente" machen. Kürzen/aufräumen ist erlaubt (Füllwörter, Wiederholungen, Verhaspler raus), aber die Wortwahl und der Sinn des Originals müssen erkennbar bleiben, damit der Name allein - ohne source_excerpt zu lesen - verständlich ist. Bei type "phase"/"group": eine kurze, zum Blockinhalt wirklich passende Überschrift - darf eine knappe thematische Zusammenfassung sein (muss nicht wörtlich im Text stehen), aber inhaltlich treffend, nicht generisch ("Sonstiges", "Weitere Punkte") oder erfunden. Bei type "milestone": der erreichte Zustand konkret benannt, z. B. "Fenster bestellt und eingebaut" - keine generische Bezeichnung wie "Meilenstein 1".',
    },
    source_excerpt: {
      type: ['string', 'null'],
      description:
        'PFLICHT, bevor du weitermachst - der Original-Textabschnitt, der zu diesem Eintrag geführt hat (exakter Wortlaut, nicht umformuliert, nicht übersetzt). Je nach type unterschiedlich umfangreich: Bei type "phase"/"group" der VOLLSTÄNDIGE Textabschnitt des ganzen Blocks (alle zugehörigen Sätze/Passagen - falls im Text verstreut, zusammenhängend aneinandergereiht); das ist der Kontext, den jemand braucht, um den ganzen Block zu verstehen. Bei type "milestone" ebenfalls der vollständige Block-Textabschnitt wie bei der zugehörigen Phase. Bei type "task" GROSSZÜGIG genug, dass der Abschnitt für sich allein verständlich ist, auch ohne den Rest des Textes zu kennen - im Zweifel lieber ein ganzer Satz oder mehrere zusammenhängende Sätze als nur der einzelne Halbsatz, der wortwörtlich passt (aber nicht zwingend der komplette Block - der steht schon bei der Phase). Ein einzelnes Wort oder ein aus dem Zusammenhang gerissener Satzteil reicht NIE. Das gilt auch bei einem einzigen langen, unstrukturierten Fließtext ohne Satzzeichen: dann trotzdem einen ausreichend langen, zusammenhängenden Abschnitt wörtlich zitieren. Fast immer gibt es einen zuzuordnenden Abschnitt. null ist die seltene Ausnahme: nur wenn der Eintrag eine reine Ergänzung von dir ist, die im Quelltext an keiner Stelle vorkommt oder angedeutet wird.',
    },
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

const BASE_RULES = `- Arbeite in zwei Schritten. Schritt 1: Lies den GANZEN Text zuerst durch und gliedere ihn in thematische Blöcke - zusammengehörige Punkte werden zusammensortiert, auch wenn sie im Text an verschiedenen Stellen verstreut vorkommen (nicht einfach stur der Textreihenfolge nach abarbeiten). Schritt 2: Arbeite Block für Block weiter, wie unten beschrieben.
- Jeder Block wird zu einer Phase/Gruppe (type "phase"/"group") - Überschrift siehe name-Feld. Darunter kommen die konkreten Vorgänge (type "task") aus genau diesem Block - Benennung siehe name-Feld.
- Jeder Block bekommt GENAU EINEN Ziel-Meilenstein (type "milestone", duration 0) ans Blockende, der den erreichten Zustand benennt (siehe name-Feld). Er hängt per depends_on (type FS) von den letzten Vorgängen seines Blocks ab. Nennt der Text selbst schon einen Termin/eine Abnahme/Freigabe als Blockende, ist DAS der Ziel-Meilenstein - keinen zusätzlichen erfinden. Nur wenn der Text keinen expliziten Endpunkt nennt, formulierst du den Zielzustand selbst.
- source_excerpt bei Phase, Ziel-Meilenstein und jedem Vorgang ausfüllen - Umfang je type siehe source_excerpt-Feld.
- Schätze für jede Aufgabe eine realistische Dauer in Arbeitstagen, wenn keine vorgegeben ist.
- Abhängigkeiten (depends_on) sind der wichtigste Teil deiner Arbeit - nimm dir dafür besondere Sorgfalt:
  - Prüfe JEDE Aufgabe einzeln: Was muss zwingend vorher fertig sein, bevor diese beginnen kann? Trage das als depends_on ein, auch wenn es nicht wörtlich im Text steht, sondern sich aus der Fachlogik ergibt (z. B. "Testen" setzt "Entwickeln" voraus, "Freigabe" setzt "Vorlage einreichen" voraus).
  - Sprachliche Signale ("nach", "sobald", "erst wenn", "Voraussetzung", "im Anschluss", "danach", "bevor") IMMER in eine Abhängigkeit übersetzen - nie nur in die Reihenfolge des Arrays, sondern explizit in depends_on.
  - Unterscheide bewusst: Aufgaben OHNE echte inhaltliche Abhängigkeit voneinander (z. B. zwei verschiedene Teams bereiten unabhängig etwas vor) bekommen KEINE künstliche Abhängigkeit - sie dürfen parallel laufen. Erfinde keine Abhängigkeit nur um eine Reihenfolge zu erzwingen.
  - type FS (Ende→Start, Standard) heißt: Vorgänger muss fertig sein. SS (Start→Start) heißt: darf gleichzeitig beginnen. Wähle bewusst, nicht immer FS.
  - Innerhalb eines Blocks: aufeinanderfolgende Schritte bekommen eine Kette von Abhängigkeiten (Schritt 2 hängt von Schritt 1 ab, Schritt 3 von Schritt 2 usw.), nicht nur alle vom Ziel-Meilenstein.
  - Zwischen Blöcken: hängt ein Vorgang in Block B inhaltlich vom Abschluss von Block A ab, trage eine Abhängigkeit zum ZIEL-MEILENSTEIN von Block A ein (nicht zur Phase selbst - die Phase ist nur die Überschrift, der Meilenstein ist der eindeutige "fertig"-Punkt).
- Die Reihenfolge im tasks-Array ist die Ausführungsreihenfolge: Block für Block (Phase, dann ihre Vorgänge, dann ihr Ziel-Meilenstein), Blöcke chronologisch. Diese Reihenfolge UND depends_on müssen zueinander passen - ein Vorgänger steht nie nach seinem Nachfolger im Array.
- Personen, die einer Aufgabe zugeordnet sind, kommen in responsible (Name oder E-Mail, sonst null).
- Antworte ausschließlich im vorgegebenen JSON-Schema, auf Deutsch.`

const SYSTEM_DOCUMENT = `Du bist Projektplaner für interne Projekte (Organisation, Coaching, Software, Bauabwicklung).
Du erhältst den Text eines Dokuments (Protokoll, Leistungsbeschreibung, Angebot, Projektbeschreibung)
und extrahierst daraus einen Aufgabenplan.
${BASE_RULES}
- Erfinde keine Inhalte. Unklares gehört in warnings. Einzige Ausnahme: die Ziel-Meilensteine pro Block (siehe oben) darfst und sollst du selbst formulieren, auch wenn der genaue Wortlaut nicht im Text steht.`

const SYSTEM_BRIEF = `Du bist Projektplaner für interne Projekte (Organisation, Coaching, Software, Bauabwicklung).
Du erhältst eine Beschreibung eines Vorhabens und entwirfst daraus einen vollständigen, praxistauglichen Projektplan.
${BASE_RULES}
- Ist der Text bereits lang und detailliert (z. B. ein abgetipptes/diktiertes Gespräch, ein Protokoll, mehrere konkrete Punkte) - verhalte dich wie beim Dokument-Import: NICHTS erfinden außer den Ziel-Meilensteinen pro Block (siehe oben). Nur wenn der Text erkennbar kurz und vage ist (eine grobe Idee, ein Satz, ohne konkrete Einzelschritte), ergänze die üblichen fehlenden Schritte (Vorbereitung, Abstimmung, Freigabe, Abschluss) und vermerke das deutlich in warnings.`

const SYSTEM_REFINE = `Du bist Projektplaner. Du erhältst einen bestehenden Projektplan als JSON und eine Anweisung zur Änderung.
Gib den vollständigen überarbeiteten Plan zurück – nicht nur die Änderungen.
${BASE_RULES}
- Behalte vorhandene Schlüssel (key) bestehender Vorgänge bei, damit nichts doppelt entsteht. Neue Vorgänge bekommen neue Schlüssel.
- source_excerpt unveränderter Vorgänge unverändert übernehmen. Für neue oder inhaltlich geänderte Vorgänge: wenn die Anweisung ein Zitat hergibt, das source_excerpt setzen, sonst null.
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
async function* streamPlanAi(system: string, userText: string, effort: 'low' | 'medium' = 'medium', schema: object = PLAN_SCHEMA, schemaName = 'plan'): AsyncGenerator<PlanAiProgress> {
  const provider = getAiProvider()
  if (!provider) throw new HttpError(500, 'KI ist nicht konfiguriert.')

  const res = await aiPost('/responses', {
    model: modelId(provider, AI_PLAN_MODEL),
    stream: true,
    instructions: system,
    input: [{ role: 'user', content: [{ type: 'input_text', text: userText }] }],
    reasoning: { effort },
    text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
    store: false,
    // Ohne jede Obergrenze kann ein Reasoning-Modell beliebig lange an internen Denkschritten
    // hängen - eine Obergrenze bleibt sinnvoll, muss aber für große Pläne (200+ Vorgänge inkl.
    // Abhängigkeiten, z. B. aus einer ganzen Meeting-Mitschrift) genug Platz lassen.
    max_output_tokens: 32_000,
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

/** Strukturierter KI-Aufruf mit eigenem Schema (z. B. Briefing). */
async function callStructuredAi(system: string, userText: string, schemaName: string, schema: object, effort: 'low' | 'medium' = 'medium'): Promise<unknown> {
  for await (const ev of streamPlanAi(system, userText, effort, schema, schemaName)) if (ev.type === 'done') return ev.parsed
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

const SINGLE_CALL_CHARS = 24_000
const CHUNK_CHARS = 24_000
const MAX_DOCUMENT_CHARS = 1_000_000
const CHUNK_CONCURRENCY = 3
// Tabellenzeilen (Excel/CSV) werden knapp ausgegeben (kein Zitat, kurzer Denkaufwand); ein zu großer Teil halbiert sich automatisch (planChunk).
const MAX_TABLE_ROWS = 200
const TABLE_CHUNK_CHARS = 60_000

/**
 * Teilt einen langen Text an Zeilengrenzen. Tabellen behalten ihren Kontext: bei CSV wird die
 * Kopfzeile, bei Excel (Abschnitte „## Blattname“) Blattname und Kopfzeile jedem Teil vorangestellt.
 */
function splitIntoChunks(text: string, fileName: string): string[] {
  const lines = text.split(/\r?\n/)
  const isCsv = /\.csv$/i.test(fileName)
  let heading: string | null = null
  let header: string | null = isCsv ? lines[0]! : null
  let expectHeader = false
  const chunks: string[] = []
  let cur: string[] = []
  let len = 0
  let rows = 0
  const flush = () => {
    if (cur.length) chunks.push(cur.join('\n'))
    cur = []
    len = 0
    rows = 0
  }
  const start = () => {
    if (heading && !isCsv) cur.push(heading)
    if (header) cur.push(header)
    len = cur.reduce((s, l) => s + l.length + 1, 0)
  }
  if (isCsv) start()
  for (let i = isCsv ? 1 : 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) continue
    if (!isCsv && line.startsWith('## ')) {
      heading = line
      header = null
      expectHeader = true
    } else if (expectHeader) {
      header = line
      expectHeader = false
    }
    const tabular = isCsv || heading !== null
    if ((len + line.length + 1 > (tabular ? TABLE_CHUNK_CHARS : CHUNK_CHARS) || (tabular && rows >= MAX_TABLE_ROWS)) && cur.length) {
      flush()
      start()
    }
    cur.push(line)
    len += line.length + 1
    if (!line.startsWith('## ') && line !== header) rows++
  }
  flush()
  return chunks
}

interface RawPlanTask { key: string; parent_key: string | null; type: string; name: string; depends_on?: { predecessor_key: string; type: string; lag_days: number }[]; [k: string]: unknown }
interface RawPlan { name?: string; tasks?: RawPlanTask[]; warnings?: string[] }

/**
 * Teilpläne zusammenführen: Schlüssel je Teil eindeutig machen, gleichnamige Phasen zusammenlegen.
 * Vorgänger-Verweise auf Schlüssel aus einem anderen Teil (z. B. ID-Spalte einer Tabelle) werden
 * über die ursprünglichen Schlüssel aufgelöst.
 */
function mergeChunkPlans(parts: RawPlan[]): RawPlan {
  const phaseByName = new Map<string, string>()
  const globalByRaw = new Map<string, string>()
  const maps: Map<string, string>[] = []
  const droppedSets: Set<string>[] = []
  parts.forEach((part, idx) => {
    const prefix = `p${idx + 1}_`
    const list = Array.isArray(part.tasks) ? part.tasks : []
    const map = new Map<string, string>()
    const dropped = new Set<string>()
    for (const t of list) {
      let newKey = prefix + t.key
      if (t.type === 'phase' || t.type === 'group') {
        const norm = String(t.name ?? '').trim().toLowerCase()
        const existing = phaseByName.get(norm)
        if (existing) {
          newKey = existing
          dropped.add(t.key)
        } else phaseByName.set(norm, newKey)
      }
      map.set(t.key, newKey)
      if (!globalByRaw.has(t.key)) globalByRaw.set(t.key, newKey)
    }
    maps.push(map)
    droppedSets.push(dropped)
  })
  const tasks: RawPlanTask[] = []
  const warnings: string[] = []
  parts.forEach((part, idx) => {
    const map = maps[idx]!
    const resolve = (k: string) => map.get(k) ?? globalByRaw.get(k)
    for (const t of Array.isArray(part.tasks) ? part.tasks : []) {
      if (droppedSets[idx]!.has(t.key)) continue
      tasks.push({
        ...t,
        key: map.get(t.key)!,
        parent_key: t.parent_key ? map.get(t.parent_key) ?? null : null,
        depends_on: (t.depends_on ?? []).filter((d) => resolve(d.predecessor_key)).map((d) => ({ ...d, predecessor_key: resolve(d.predecessor_key)! })),
      })
    }
    for (const w of part.warnings ?? []) if (!warnings.includes(w)) warnings.push(w)
  })
  return { name: parts[0]?.name, tasks, warnings }
}

/** Teilt einen Teil (Kontextzeilen bleiben vorn) in zwei Hälften; null, wenn nicht teilbar. */
function halveChunk(chunk: string, isCsv: boolean): [string, string] | null {
  const lines = chunk.split('\n')
  const ctx = isCsv ? 1 : lines[0]?.startsWith('## ') ? 2 : 0
  const body = lines.slice(ctx)
  if (body.length < 2) return null
  const mid = Math.ceil(body.length / 2)
  return [[...lines.slice(0, ctx), ...body.slice(0, mid)].join('\n'), [...lines.slice(0, ctx), ...body.slice(mid)].join('\n')]
}

/** Einen Teil planen; wird die Antwort zu groß, halbiert sich der Teil und beide Hälften laufen nacheinander. */
async function planChunk(fileName: string, hint: string, label: string, chunk: string, isCsv: boolean, depth = 0): Promise<RawPlan[]> {
  try {
    return [(await callPlanAi(SYSTEM_DOCUMENT, `Dateiname: ${fileName}\nHinweis: ${hint}\n\nDokumenttext (${label}):\n\n${chunk}`, 'low')) as RawPlan]
  } catch (e) {
    if (e instanceof HttpError && e.status === 502 && /abgeschnitten|zu umfangreich/i.test(e.message) && depth < 3) {
      const halves = halveChunk(chunk, isCsv)
      if (halves) {
        const first = await planChunk(fileName, hint, `${label}a`, halves[0], isCsv, depth + 1)
        const second = await planChunk(fileName, hint, `${label}b`, halves[1], isCsv, depth + 1)
        return [...first, ...second]
      }
    }
    throw e
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Wie extractPlanFromText, meldet zwischendurch die Anzahl bereits entworfener Aufgaben. */
export async function* extractPlanFromTextStream(text: string, fileName: string, hint?: string): AsyncGenerator<{ type: 'progress'; tasks: number } | { type: 'done'; plan: ExtractedPlan }> {
  const clipped = text.slice(0, MAX_DOCUMENT_CHARS)
  if (clipped.trim().length < 40) throw new HttpError(400, 'Aus dem Dokument konnte kein Text gelesen werden (evtl. ein Scan ohne Textebene).')
  let parsed: unknown = null
  if (clipped.length <= SINGLE_CALL_CHARS) {
    for await (const ev of streamPlanAi(SYSTEM_DOCUMENT, `Dateiname: ${fileName}\n${hint ? `Hinweis: ${hint}\n` : ''}\nDokumenttext:\n\n${clipped}`, 'medium')) {
      if (ev.type === 'progress') yield ev
      else parsed = ev.parsed
    }
  } else {
    // Sehr langes Dokument (z. B. Ticketliste oder Plantabelle mit hunderten Zeilen): in Teile zerlegen, parallel auswerten, zusammenführen.
    const chunks = splitIntoChunks(clipped, fileName)
    const isCsv = /\.csv$/i.test(fileName)
    const results: RawPlan[][] = new Array(chunks.length)
    let total = 0
    for (let start = 0; start < chunks.length; start += CHUNK_CONCURRENCY) {
      const batch = chunks.slice(start, start + CHUNK_CONCURRENCY).map(async (chunk, j) => {
        const n = start + j + 1
        const chunkHint = `${chunks.length > 1 ? `Dies ist Teil ${n} von ${chunks.length} eines sehr langen Dokuments; plane nur die Inhalte dieses Teils. ` : 'Dies ist ein sehr langes Dokument. '}Bei einer Tabelle (Excel/CSV): jede Zeile wird ein Vorgang, source_excerpt immer null (die Zeile ist die Quelle) und notes nur kurz, damit die Antwort klein bleibt. Hat die Tabelle eine ID-Spalte, verwende die ID als key und trage Vorgänger aus der Vorgänger-Spalte immer als predecessor_key ein - auch wenn die ID in einem anderen Teil steht. Eine Spalte „Ebene“ oder „Gliederung“ gibt die Hierarchie vor (Phase > Gruppe > Vorgang). Thematisch gleiche Inhalte bekommen dieselben Phasennamen wie in den übrigen Teilen.${hint ? ` ${hint}` : ''}`
        try {
          const raws = await planChunk(fileName, chunkHint, `Teil ${n}/${chunks.length}`, chunk, isCsv)
          results[start + j] = raws
          for (const raw of raws) total += Array.isArray(raw.tasks) ? raw.tasks.length : 0
        } catch (e) {
          throw e instanceof HttpError ? new HttpError(e.status, `Teil ${n} von ${chunks.length}: ${e.message}`) : e
        }
      })
      const all = Promise.all(batch)
      let settled = false
      all.then(() => { settled = true }, () => { settled = true })
      while (!settled) {
        await Promise.race([all.catch(() => undefined), sleep(10_000)])
        if (!settled) yield { type: 'progress', tasks: total }
      }
      await all
      yield { type: 'progress', tasks: total }
    }
    const merged = mergeChunkPlans(results.flat())
    merged.warnings = [`Das Dokument war sehr lang und wurde in ${chunks.length} Teilen ausgewertet. Gleichnamige Phasen wurden zusammengelegt, Abhängigkeiten über Teilgrenzen hinweg bitte prüfen.`, ...(merged.warnings ?? [])]
    parsed = merged
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
  for await (const ev of streamPlanAi(SYSTEM_BRIEF, `Beschreibung des Vorhabens:${kind}${people}\n\n${text.slice(0, 100_000)}`, context?.effort ?? 'medium')) {
    if (ev.type === 'progress') yield ev
    else parsed = ev.parsed
  }
  const plan = normalizeExtractedPlan(parsed, { source: 'document', name: 'KI-Projektplan', reference: 'KI-Entwurf' })
  if (!plan.tasks.length) throw new HttpError(422, 'Die KI konnte aus der Beschreibung keinen Plan ableiten.')
  yield { type: 'done', plan }
}

// ---------------------------------------------------------------- Überarbeiten (auch sehr große Pläne)
const REFINE_SINGLE_MAX_TASKS = 60
const REFINE_SECTION_MAX_TASKS = 70
const REFINE_CONCURRENCY = 3

const BRIEFING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'important', 'unimportant', 'cross_links', 'guidance'],
  properties: {
    summary: { type: 'string', description: 'Worum geht es im Gesamtplan? Ziel, Aufbau und Zusammenhang der Bereiche in 4-8 Sätzen.' },
    important: { type: 'array', items: { type: 'string' }, description: 'Bereiche/Vorgänge (Schlüssel oder Bezeichnung), die für das Ziel wirklich tragend sind.' },
    unimportant: { type: 'array', items: { type: 'string' }, description: 'Nebensächliches, Doppeltes, Veraltetes oder Rauschen (Schlüssel oder Bezeichnung) und kurz warum.' },
    cross_links: { type: 'array', items: { type: 'string' }, description: 'Zusammenhänge zwischen Abschnitten, die ein Bearbeiter einzelner Abschnitte kennen muss (baut auf, Dopplung, gemeinsame Begriffe), mit Schlüsseln.' },
    guidance: { type: 'string', description: 'Was die Anweisung konkret für jeden Abschnitt bedeutet: einheitliche Maßstäbe, Namensregeln, Detailtiefe.' },
  },
} as const

const SYSTEM_BRIEFING = `Du bist Planungsleiter. Du erhältst einen kompletten Plan (oft über Zeit gewachsen und unordentlich: Wichtiges, Unwichtiges und Doppeltes gemischt) und eine Anweisung zur Überarbeitung.
Mehrere Bearbeiter überarbeiten gleich jeweils nur EINEN Abschnitt und sehen vom Rest nur eine Übersicht. Du schreibst ihnen das Briefing, damit alle den ganzen Plan richtig verstehen und einheitlich arbeiten.
- Verstehe den Plan als Ganzes: Ziel, Aufbau, wie die Bereiche zusammenhängen. Beurteile selbst, was wichtig und was nebensächlich, doppelt oder veraltet ist.
- Erfinde nichts. Beziehe dich auf Schlüssel (key) und Bezeichnungen aus dem Plan.
- Übersetze die Anweisung in konkrete, für alle Abschnitte gleiche Maßstäbe (guidance).
- Antworte ausschließlich im vorgegebenen JSON-Schema, auf Deutsch.`

const SYSTEM_REFINE_SECTION = `${SYSTEM_REFINE}
ABSCHNITTSMODUS (hat Vorrang vor der Vorgabe, den vollständigen Plan zurückzugeben):
- Du bearbeitest ausschließlich die Vorgänge des Abschnitts. Gib NUR die Vorgänge dieses Abschnitts zurück (vollständig, geändert oder unverändert), keine Vorgänge anderer Abschnitte.
- Den Gesamtplan bekommst du nur zur Orientierung. Beziehe das Briefing und den Zusammenhang des ganzen Plans in jede Entscheidung ein (was wichtig ist, was Rauschen ist, was in anderen Abschnitten schon vorkommt).
- Verweise auf Vorgänge anderer Abschnitte sind erlaubt (predecessor_key bzw. parent_key aus dem Gesamtplan); diese Vorgänge selbst änderst du nicht.
- Vorgänge, die laut Anweisung und Briefing überflüssig oder doppelt sind, lässt du weg; neue Vorgänge bekommen neue Schlüssel.`

interface PlanSection { tasks: ExtractedTask[] }

/** Teilt einen Plan in zusammenhängende Abschnitte (in Plan-Reihenfolge, höchstens REFINE_SECTION_MAX_TASKS Vorgänge). */
function splitPlanSections(plan: ExtractedPlan): PlanSection[] {
  const byKey = new Map(plan.tasks.map((t) => [t.key, t]))
  const children = new Map<string | null, ExtractedTask[]>()
  for (const t of plan.tasks) {
    const parent = t.parent_key && byKey.has(t.parent_key) ? t.parent_key : null
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent)!.push(t)
  }
  const subtree = (t: ExtractedTask): ExtractedTask[] => [t, ...(children.get(t.key) ?? []).flatMap(subtree)]
  const small: ExtractedTask[][] = []
  const walk = (nodes: ExtractedTask[]) => {
    for (const n of nodes) {
      const sub = subtree(n)
      const kids = children.get(n.key) ?? []
      if (sub.length <= REFINE_SECTION_MAX_TASKS || !kids.length) small.push(sub)
      else {
        small.push([n])
        walk(kids)
      }
    }
  }
  walk(children.get(null) ?? [])
  const sections: PlanSection[] = []
  let cur: ExtractedTask[] = []
  for (const part of small) {
    if (cur.length && cur.length + part.length > REFINE_SECTION_MAX_TASKS) {
      sections.push({ tasks: cur })
      cur = []
    }
    cur = cur.concat(part)
  }
  if (cur.length) sections.push({ tasks: cur })
  return sections
}

/** Überarbeiteten Abschnitt prüfen: Schlüssel anderer Abschnitte vermeiden, Notizen/Zitate unveränderter Vorgänge behalten. */
function reconcileSection(raw: unknown, section: PlanSection, allKeys: Set<string>, index: number): RawPlanTask[] {
  const own = new Map(section.tasks.map((t) => [t.key, t]))
  // Vorgänge anderer Abschnitte gehören nicht in diese Antwort und werden verworfen; Verweise auf sie bleiben gültig.
  const returned = (Array.isArray((raw as RawPlan | null)?.tasks) ? ((raw as RawPlan).tasks as RawPlanTask[]) : []).filter((t) => own.has(t.key) || !allKeys.has(t.key))
  const rename = new Map<string, string>()
  for (const t of returned) if (!allKeys.has(t.key)) rename.set(t.key, t.key.startsWith(`n${index}_`) ? t.key : `n${index}_${t.key}`)
  const fix = (k: string) => rename.get(k) ?? k
  return returned.map((t) => {
    const original = own.get(t.key)
    const next: RawPlanTask = {
      ...t,
      key: fix(t.key),
      parent_key: t.parent_key ? fix(t.parent_key) : null,
      depends_on: (t.depends_on ?? []).map((d) => ({ ...d, predecessor_key: fix(d.predecessor_key) })),
    }
    if (original) {
      if (!next.source_excerpt && original.source_excerpt) next.source_excerpt = original.source_excerpt
      if (!next.notes && original.notes) next.notes = original.notes
    }
    return next
  })
}

/** Bestehenden Plan nach Anweisung erweitern oder optimieren; große Pläne mit Gesamtbriefing abschnittsweise. */
export async function* refinePlanStream(plan: ExtractedPlan, instruction: string, people?: string[]): AsyncGenerator<{ type: 'progress'; tasks: number } | { type: 'done'; plan: ExtractedPlan }> {
  const task = instruction.trim()
  if (!task) throw new HttpError(400, 'Bitte beschreibe, was geändert werden soll.')
  const peopleLine = people?.length ? `\nVerfügbare Personen (nur diese als responsible verwenden): ${people.join(', ')}` : ''
  const fallback = { source: plan.source, name: plan.name, reference: plan.reference }

  if (plan.tasks.length <= REFINE_SINGLE_MAX_TASKS) {
    const parsed = await callPlanAi(SYSTEM_REFINE, `Anweisung: ${task}${peopleLine}\n\nBestehender Plan:\n${planToPrompt(plan)}`)
    const next = normalizeExtractedPlan(parsed, fallback)
    if (!next.tasks.length) throw new HttpError(422, 'Die KI hat keinen verwertbaren Plan zurückgegeben.')
    yield { type: 'done', plan: next }
    return
  }

  // Große Pläne: 1) Briefing über den GANZEN Plan, 2) je Abschnitt überarbeiten (mit Briefing und Gesamtübersicht), 3) zusammenführen.
  const overview = planToPrompt(plan)
  const briefing = (await callStructuredAi(SYSTEM_BRIEFING, `Anweisung: ${task}${peopleLine}\n\nGesamtplan:\n${overview}`, 'briefing', BRIEFING_SCHEMA, 'medium')) as {
    summary: string; important: string[]; unimportant: string[]; cross_links: string[]; guidance: string
  }
  const briefingText = [
    `Zusammenfassung: ${briefing.summary}`,
    `Tragend/wichtig: ${(briefing.important ?? []).join('; ') || '-'}`,
    `Nebensächlich/doppelt/veraltet: ${(briefing.unimportant ?? []).join('; ') || '-'}`,
    `Zusammenhänge zwischen Abschnitten: ${(briefing.cross_links ?? []).join('; ') || '-'}`,
    `Maßstäbe für alle Abschnitte: ${briefing.guidance}`,
  ].join('\n')

  const sections = splitPlanSections(plan)
  const allKeys = new Set(plan.tasks.map((t) => t.key))
  const results: RawPlanTask[][] = new Array(sections.length)
  const sectionWarnings: string[] = []
  let done = 0
  yield { type: 'progress', tasks: 0 }
  for (let start = 0; start < sections.length; start += REFINE_CONCURRENCY) {
    const batch = sections.slice(start, start + REFINE_CONCURRENCY).map(async (section, j) => {
      const index = start + j + 1
      const prompt = `Anweisung: ${task}${peopleLine}\n\nBriefing zum Gesamtplan:\n${briefingText}\n\nGesamtplan (nur zur Orientierung):\n${overview}\n\nABSCHNITT ${index} von ${sections.length} - nur diese Vorgänge überarbeiten und zurückgeben:\n${planToPrompt({ ...plan, tasks: section.tasks })}`
      try {
        const raw = await callPlanAi(SYSTEM_REFINE_SECTION, prompt, 'medium')
        results[start + j] = reconcileSection(raw, section, allKeys, index)
        for (const w of (raw as RawPlan).warnings ?? []) if (!sectionWarnings.includes(w)) sectionWarnings.push(w)
        done += section.tasks.length
      } catch (e) {
        throw e instanceof HttpError ? new HttpError(e.status, `Abschnitt ${index} von ${sections.length}: ${e.message}`) : e
      }
    })
    const all = Promise.all(batch)
    let settled = false
    all.then(() => { settled = true }, () => { settled = true })
    while (!settled) {
      await Promise.race([all.catch(() => undefined), sleep(10_000)])
      if (!settled) yield { type: 'progress', tasks: done }
    }
    await all
    yield { type: 'progress', tasks: done }
  }

  const warnings = [`Großer Plan: ${plan.tasks.length} Vorgänge in ${sections.length} Abschnitten überarbeitet, jeweils mit Briefing über den Gesamtplan. Briefing: ${briefing.summary}`, ...sectionWarnings]
  const next = normalizeExtractedPlan({ name: plan.name, tasks: results.flat(), warnings }, fallback)
  if (!next.tasks.length) throw new HttpError(422, 'Die KI hat keinen verwertbaren Plan zurückgegeben.')
  yield { type: 'done', plan: next }
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
