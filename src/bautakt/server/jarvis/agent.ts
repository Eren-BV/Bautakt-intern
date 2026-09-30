/**
 * Eine Jarvis-Gesprächsrunde: Bestätigung des Nutzers verarbeiten, dann Modell und Werkzeuge
 * im Wechsel aufrufen, alle Ereignisse an den Client streamen und die Nutzung protokollieren.
 */

import type { Db } from '../db.ts'
import { newId, nowISO } from '../db.ts'
import { HttpError } from '../auth.ts'
import { Repo } from '../repo.ts'
import type { Session } from '../../shared/types.ts'
import type { JarvisContext, JarvisEvent, JarvisItem, JarvisTurnRequest } from '../../shared/jarvis/protocol.ts'
import { addDays, todayISO } from '../../shared/engine/dates.ts'
import { getAiProvider } from '../services/aiGateway.ts'
import { JARVIS_MODEL, runModel, type ModelUsage } from './llm.ts'
import { SYSTEM_PROMPT, developerContext } from './prompt.ts'
import { TOOL_DEFS, executeTool, parseArgs, toolExists } from './tools/index.ts'
import type { ToolCtx, ToolResult } from './tools/common.ts'
import { cancelPending, claimPending, finishAction } from './actions.ts'

const MAX_MODEL_CALLS = 110
const MAX_TOOL_CALLS = 220
const DAILY_TURNS = Number(process.env['JARVIS_DAILY_TURNS'] || 300)
const HISTORY_CHARS = 16_000

/**
 * Schreibwerkzeuge, deren `summary` allein schon eine gute, vollständige Antwort ist. Ruft der
 * Nutzer eins davon direkt auf (klare Absicht, ein einzelner Aufruf, sofort erfolgreich), spart
 * sich Jarvis die zweite Modellrunde nur fürs Umformulieren - das ist die häufigste Runde und die
 * größte vermeidbare Wartezeit. Lesewerkzeuge (find, get_*, get_briefing) bleiben außen vor: ihre
 * Ergebnisse sind strukturierte Daten, die das Modell erst zu einer Antwort zusammensetzen muss.
 */
const DIRECT_SPEAKABLE_TOOLS = new Set([
  'change_schedule', 'create_task', 'assign_task', 'report_progress', 'create_project',
  'plan_with_ai', 'link_tasks', 'delete_tasks', 'decide_proposal', 'undo_last', 'show',
  'import_lucid_diagram', 'send_email', 'file_email_attachment',
])

/** Kurze Antworten auf eine Bestätigungskarte („Ja, mach.“, „Nein, lass es.“) brauchen keinen Modellaufruf. */
const ANSWER_WORDS = new Set([
  'ja', 'jawohl', 'jo', 'jup', 'klar', 'genau', 'okay', 'ok', 'passt', 'gut', 'super', 'prima', 'alles', 'richtig',
  'mach', 'machs', 'das', 'es', 'so', 'bitte', 'gerne', 'los', 'bestaetige', 'bestaetigt', 'einverstanden', 'danke',
  'nein', 'nee', 'abbrechen', 'stopp', 'stop', 'lass', 'doch', 'nicht', 'lieber', 'boss', 'jarvis', 'chef',
])
function isPlainAnswer(text: string): boolean {
  const words = text.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').split(/[^a-z]+/).filter(Boolean)
  return words.length > 0 && words.length <= 6 && words.every((w) => ANSWER_WORDS.has(w))
}

/**
 * Grobe Erkennung: Deutet der Satz auf mehrere einzelne Dinge hin ("leg vier Vorgänge an: A, B,
 * C, D")? Ruft das Modell darauf nur EIN Werkzeug auf (statt mehrere auf einmal, wie im Prompt
 * verlangt), heißt das oft nicht "fertig", sondern "macht eins nach dem anderen" - dann darf der
 * Schnellpfad nicht nach dem ersten Aufruf abbrechen, sonst gehen die übrigen Dinge stillschweigend
 * verloren. Lieber einmal unnötig weiterlaufen lassen als Nutzeranweisungen halb ausführen.
 */
function impliesMultipleItems(text: string): boolean {
  const t = text.toLowerCase()
  if (/\b(alle|jede[nr]?|mehrere|beide)\b/.test(t)) return true
  if ((text.match(/,/g)?.length ?? 0) >= 2) return true
  if (/\b(zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|\d+)\s+\w*(vorgäng|aufgaben|meilenstein|personen|firmen|mails?|e-?mails?)/.test(t)) return true
  return false
}

export async function runTurn(db: Db, session: Session, req: JarvisTurnRequest, emit: (e: JarvisEvent) => void, signal?: AbortSignal): Promise<void> {
  const started = Date.now()
  const turnId = typeof req?.turn_id === 'string' && req.turn_id ? req.turn_id.slice(0, 40) : newId('turn')
  const usage: ModelUsage = { input: 0, cached: 0, output: 0 }
  let firstText: number | null = null
  let iterations = 0
  let toolCalls = 0
  let error: string | null = null
  let expectsReply = false
  let lastText = ''
  const provider = getAiProvider()
  emit({ type: 'turn_start', turn_id: turnId })

  try {
    if (!provider) {
      emit({ type: 'error', code: 'ai_unavailable', message: 'Die KI ist nicht konfiguriert.' })
      return
    }
    const recent = await db.get<{ n: number }>('SELECT count(*)::int AS n FROM jarvis_turns WHERE user_id = ? AND created_at > ?', session.user.id, new Date(Date.now() - 86400_000).toISOString())
    if ((recent?.n ?? 0) >= DAILY_TURNS) {
      emit({ type: 'error', code: 'rate_limited', message: 'Das Tageslimit für Jarvis ist erreicht. Morgen geht es weiter.' })
      return
    }

    const context = sanitizeContext(req.context)
    const today = clampToday(context.today)
    // Kein künstliches Kürzen der aktuellen Eingabe - nur ein technisches Sicherheitsnetz gegen
    // versehentlich riesige Anfragen (siehe generatePlanFromBrief für dasselbe Limit). Für ganze
    // Meeting-Mitschriften ist „Aus Beschreibung“ (Plan-Import) trotzdem der bessere Weg: ein
    // einzelner KI-Durchlauf ohne Schrittlimit statt vieler einzelner Jarvis-Werkzeugaufrufe.
    const text = String(req.input?.text ?? '').trim().slice(0, 100_000)
    const via = req.input?.via === 'voice' ? 'voice' : 'text'
    if (text) {
      // Organisationsweit protokollieren - auch ohne Projektbezug (Dashboard, Projektliste …).
      void db.insert('jarvis_commands', {
        id: newId('jc'), org_id: session.org.id, project_id: context.project_id ?? null,
        user_id: session.user.id, user_name: session.user.name, text, via, created_at: nowISO(),
      }).catch(() => {})
      // Zusätzlich in der Projekt-Historie, wenn ein Projekt im Kontext ist - unabhängig vom
      // Ergebnis, das Jarvis dann tut (das wird separat mit source FUTURE_AI protokolliert).
      if (context.project_id) {
        void db.insert('change_history', {
          id: newId('ch'), project_id: context.project_id, task_id: context.task_id ?? null, task_name: '',
          user_id: session.user.id, user_name: session.user.name, created_at: nowISO(),
          field: 'ki_anfrage', old_value: null, new_value: text,
          reason: via === 'voice' ? 'Diktiert' : 'Eingegeben', source: 'FUTURE_AI',
        }).catch(() => {})
      }
    }
    const history = sanitizeHistory(req.history)
    const newItems: JarvisItem[] = []
    const conversationId = typeof req.conversation_id === 'string' && /^[\w-]{1,64}$/.test(req.conversation_id) ? req.conversation_id : null
    const base = { db, session, context, today, emit, conversationId, writes: { count: 0 } }
    const say = (t: string) => {
      if (firstText === null) firstText = Date.now() - started
      emit({ type: 'text_delta', text: t })
      lastText = t
    }

    // 1) Bestätigung aus der Karte bzw. gesprochenes Ja/Nein - entscheidet immer der Nutzer.
    let confirmNote: string | null = null
    if (req.confirm?.action_id) {
      const reply = await handleConfirmation({ ...base, callId: newId('call'), confirmed: null }, req.confirm)
      newItems.push({ role: 'user', content: text || (req.confirm.decision === 'confirm' ? 'Ja' : 'Nein') }, { role: 'assistant', content: reply.text })
      say(reply.text)
      if (reply.needsConfirmation) expectsReply = true
      if (!text || isPlainAnswer(text)) {
        emit({ type: 'items', items: newItems })
        return
      }
      confirmNote = `Ergebnis der vom Nutzer bestätigten Aktion (bereits gesagt): ${reply.text} Erledige jetzt nur noch den übrigen Teil seiner Anweisung.`
    }
    if (!text) {
      emit({ type: 'items', items: newItems })
      return
    }

    // 2) Modell und Werkzeuge im Wechsel
    const repo = new Repo(db)
    const project = context.project_id ? await repo.project(session.org.id, context.project_id) : null
    const task = project && context.task_id ? await db.get<{ id: string; name: string }>('SELECT id, name FROM tasks WHERE id = ? AND project_id = ?', context.task_id, project.id) : null
    const templates = await repo.templates(session.org.id)
    const developer = { role: 'developer', content: developerContext({ session, context, today, via, project: project ? { id: project.id, name: project.name, planning_kind: project.planning_kind } : null, task: task ?? null, templates }) }
    const userMsg: JarvisItem = { role: 'user', content: text }
    if (!confirmNote) newItems.push(userMsg)
    const input: unknown[] = [...history, developer, userMsg, ...(confirmNote ? [{ role: 'developer', content: confirmNote }] : [])]

    let spoken = lastText
    for (;;) {
      iterations++
      let callText = ''
      const res = await runModel({
        provider,
        instructions: SYSTEM_PROMPT,
        tools: TOOL_DEFS,
        input,
        signal,
        onText: (d) => {
          if (firstText === null) firstText = Date.now() - started
          // Text aus einem neuen Modellaufruf: vom vorherigen Satz trennen
          const delta = !callText && spoken && !/\s$/.test(spoken) && !/^\s/.test(d) ? ` ${d}` : d
          callText += d
          spoken += delta
          emit({ type: 'text_delta', text: delta })
        },
      })
      usage.input += res.usage.input
      usage.cached += res.usage.cached
      usage.output += res.usage.output
      input.push(...res.output)
      if (callText.trim()) {
        newItems.push({ role: 'assistant', content: callText.trim() })
        lastText = callText
      }
      const calls = res.output.filter((i) => i.type === 'function_call')
      if (!calls.length) break
      let shortcut = false
      for (const call of calls) {
        toolCalls++
        const name = String(call.name ?? '')
        const callId = String(call.call_id ?? newId('call'))
        const args = parseArgs(call.arguments)
        const ctx: ToolCtx = { ...base, callId, confirmed: null }
        const result: ToolResult = args ? await executeTool(ctx, name, args) : { ok: false, status: 'invalid', message: 'Die Argumente waren kein gültiges JSON.' }
        if (result.status === 'needs_confirmation') expectsReply = true
        const output = JSON.stringify(result).slice(0, 6000)
        input.push({ type: 'function_call_output', call_id: callId, output })
        newItems.push({ type: 'function_call', call_id: callId, name, arguments: String(call.arguments ?? '{}').slice(0, 2000) }, { type: 'function_call_output', call_id: callId, output: output.slice(0, 1500) })

        // Schnellpfad: einzelner, direkt erfolgreicher Aufruf - keine zweite Modellrunde nur fürs
        // Umformulieren, und kein gesprochener/geschriebener Rückblick. Die Schrittzeile (Symbol +
        // Zusammenfassung) im Verlauf reicht als Beleg; der Nutzer sagt etwas, Jarvis tut es, fertig.
        // Klingt der Satz nach mehreren Dingen, aber das Modell hat nur eins aufgerufen, macht es
        // vermutlich eins nach dem anderen - dann nicht abbrechen, sonst gehen die übrigen verloren.
        if (iterations === 1 && calls.length === 1 && result.ok && DIRECT_SPEAKABLE_TOOLS.has(name) && !impliesMultipleItems(text)) {
          shortcut = true
        }
      }
      if (shortcut) break
      if (iterations >= MAX_MODEL_CALLS || toolCalls >= MAX_TOOL_CALLS) {
        const msg = 'Das waren viele Schritte auf einmal. Sag mir, ob ich weitermachen soll.'
        emit({ type: 'text_delta', text: `${lastText ? ' ' : ''}${msg}` })
        newItems.push({ role: 'assistant', content: msg })
        lastText = msg
        break
      }
    }
    emit({ type: 'items', items: newItems })
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    error = e instanceof Error ? e.message : String(e)
    if (signal?.aborted) return
    if (!(e instanceof HttpError)) console.error('[jarvis] Runde fehlgeschlagen', e)
    emit({
      type: 'error',
      code: status === 429 ? 'rate_limited' : status === 402 ? 'credits' : status === 503 ? 'ai_unavailable' : status === 403 ? 'forbidden' : status === 409 ? 'conflict' : 'internal',
      message: e instanceof HttpError ? e.message : 'Da ist etwas schiefgegangen. Bitte versuch es noch einmal.',
    })
  } finally {
    expectsReply = expectsReply || /\?\s*["“”]?\s*$/.test(lastText.trim())
    if (!signal?.aborted) {
      emit({ type: 'done', turn_id: turnId, expects_reply: expectsReply, timings: { first_text_ms: firstText, total_ms: Date.now() - started }, usage })
    }
    if (provider) {
      await db
        .insert('jarvis_turns', {
          id: newId('jt'), org_id: session.org.id, user_id: session.user.id, created_at: nowISO(), provider: provider.kind, model: JARVIS_MODEL,
          iterations, tool_calls: toolCalls, input_tokens: usage.input, cached_tokens: usage.cached, output_tokens: usage.output, duration_ms: Date.now() - started, error,
        })
        .catch((err) => console.error('[jarvis] Nutzung konnte nicht protokolliert werden', err))
    }
  }
}

async function handleConfirmation(ctx: ToolCtx, confirm: NonNullable<JarvisTurnRequest['confirm']>): Promise<{ text: string; needsConfirmation: boolean }> {
  if (confirm.decision === 'cancel') {
    const ok = await cancelPending(ctx.db, ctx.session, confirm.action_id)
    return { text: ok ? 'Alles klar, ich lasse es.' : 'Das war schon erledigt oder ist abgelaufen.', needsConfirmation: false }
  }
  const action = await claimPending(ctx.db, ctx.session, confirm.action_id)
  if (!action) return { text: 'Diese Bestätigung ist abgelaufen oder wurde schon verarbeitet.', needsConfirmation: false }
  const result = await executeTool({ ...ctx, confirmed: { action_id: action.id, fingerprint: action.fingerprint } }, action.tool, action.args)
  if (result.ok) {
    // create_project und plan_with_ai schließen ihre vorgemerkte Aktion selbst ab (inkl. Rückgängig-Daten)
    if (action.tool !== 'create_project' && action.tool !== 'plan_with_ai') await finishAction(ctx.db, action.id, { status: 'done' })
    return { text: `Erledigt. ${result.summary ?? ''}`.trim(), needsConfirmation: false }
  }
  if (result.status === 'needs_confirmation') {
    await finishAction(ctx.db, action.id, { status: 'superseded' })
    return { text: 'Der Plan hat sich inzwischen geändert. Schau dir die neue Auswirkung an – soll ich trotzdem?', needsConfirmation: true }
  }
  await finishAction(ctx.db, action.id, { status: 'failed' })
  return { text: String(result.message ?? 'Das hat leider nicht geklappt.'), needsConfirmation: false }
}

/** Heute aus Sicht des Nutzers - aber nur, wenn es plausibel ist (± 1 Tag zur Serverzeit). */
function clampToday(clientToday: string): string {
  const server = todayISO()
  if (/^\d{4}-\d{2}-\d{2}$/.test(clientToday) && clientToday >= addDays(server, -1) && clientToday <= addDays(server, 1)) return clientToday
  return server
}

function sanitizeContext(raw: unknown): JarvisContext {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const id = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : null)
  return {
    today: typeof c.today === 'string' ? c.today : '',
    tz: typeof c.tz === 'string' ? c.tz.slice(0, 64) : 'Europe/Berlin',
    path: typeof c.path === 'string' ? c.path.slice(0, 200) : '/',
    project_id: id(c.project_id),
    task_id: id(c.task_id),
    view: c.view === 'mobile' ? 'mobile' : 'desktop',
  }
}

/**
 * Die Historie kommt vom Client und ist nicht vertrauenswürdig: nur erlaubte Item-Arten,
 * Werkzeugaufrufe nur mit passendem Ergebnis und nur aus den letzten beiden Nutzerrunden,
 * Längen begrenzt.
 */
export function sanitizeHistory(raw: unknown): JarvisItem[] {
  if (!Array.isArray(raw)) return []
  let items: JarvisItem[] = []
  for (const it of raw.slice(-80)) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    if ((o.role === 'user' || o.role === 'assistant') && typeof o.content === 'string' && o.content.trim()) {
      items.push({ role: o.role, content: o.content.slice(0, 2000) })
    } else if (o.type === 'function_call' && typeof o.call_id === 'string' && typeof o.name === 'string' && toolExists(o.name)) {
      items.push({ type: 'function_call', call_id: o.call_id.slice(0, 80), name: o.name, arguments: typeof o.arguments === 'string' ? o.arguments.slice(0, 2000) : '{}' })
    } else if (o.type === 'function_call_output' && typeof o.call_id === 'string' && typeof o.output === 'string') {
      items.push({ type: 'function_call_output', call_id: o.call_id.slice(0, 80), output: o.output.slice(0, 1500) })
    }
  }
  // Ältere Werkzeugpaare weglassen - die Textantworten fassen sie zusammen.
  const userIdx = items.map((it, i) => ('role' in it && it.role === 'user' ? i : -1)).filter((i) => i >= 0)
  const keepToolsFrom = userIdx.length >= 2 ? userIdx[userIdx.length - 2]! : 0
  items = items.filter((it, i) => 'role' in it || i >= keepToolsFrom)
  // Gesamtlänge von hinten begrenzen
  let total = 0
  let start = items.length
  while (start > 0) {
    const it = items[start - 1]!
    total += 'role' in it ? it.content.length : 'output' in it ? it.output.length : it.arguments.length
    if (total > HISTORY_CHARS) break
    start--
  }
  items = items.slice(start)
  // Aufrufe nur mit Ergebnis (und umgekehrt), Reihenfolge Aufruf vor Ergebnis
  const seenCalls = new Set<string>()
  const outputs = new Set(items.filter((i): i is Extract<JarvisItem, { type: 'function_call_output' }> => 'type' in i && i.type === 'function_call_output').map((i) => i.call_id))
  return items.filter((it) => {
    if ('role' in it) return true
    if (it.type === 'function_call') {
      if (!outputs.has(it.call_id)) return false
      seenCalls.add(it.call_id)
      return true
    }
    return seenCalls.has(it.call_id)
  })
}
