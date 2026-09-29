/**
 * Jarvis-Routen: Gesprächsrunde (Server-Sent Events), Sprachausgabe/-erkennung über den
 * KI-Anbieter und das Rückgängigmachen einzelner Aktionen aus der Aktionsliste.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { HttpError, requireCap, type AppEnv } from '../auth.ts'
import { can } from '../../shared/permissions.ts'
import { Repo } from '../repo.ts'
import { aiPost, getAiProvider, modelId } from '../services/aiGateway.ts'
import type { JarvisEvent, JarvisTurnRequest } from '../../shared/jarvis/protocol.ts'
import { todayISO } from '../../shared/engine/dates.ts'
import { runTurn } from '../jarvis/agent.ts'
import { JARVIS_MODEL, runModel } from '../jarvis/llm.ts'
import { getAction } from '../jarvis/actions.ts'
import { undoAction } from '../jarvis/tools/write.ts'
import { executeTool } from '../jarvis/tools/index.ts'
import type { ToolCtx } from '../jarvis/tools/common.ts'

const TTS_MODEL = process.env['JARVIS_TTS_MODEL'] || 'openai/gpt-4o-mini-tts'
// „marin“: neuere, natürlicher und knapper klingende Stimme (spricht denselben Text spürbar zügiger als „onyx“)
const TTS_VOICE = process.env['JARVIS_TTS_VOICE'] || 'marin'
/** Sprechtempo der KI-Stimme (1 = normal); 1,25 wirkt spürbar zügiger, ohne gehetzt zu klingen */
const TTS_SPEED = Math.min(1.5, Math.max(0.8, Number(process.env['JARVIS_TTS_SPEED']) || 1.25))
const STT_MODEL = process.env['JARVIS_STT_MODEL'] || 'openai/gpt-4o-mini-transcribe'

export const jarvisRoutes = new Hono<AppEnv>()

jarvisRoutes.get('/jarvis/status', async (c) => {
  const provider = getAiProvider()
  const status = {
    ai: !!provider,
    provider: provider?.kind ?? null,
    model: JARVIS_MODEL,
    tts: !!provider && process.env['JARVIS_TTS'] !== 'off',
    stt: !!provider && process.env['JARVIS_STT'] !== 'off',
  }
  if (c.req.query('probe') !== '1') return c.json(status)
  // ?probe=1: nach dem Veröffentlichen prüfen, ob der KI-Zugang Werkzeugaufrufe und Stimme kann
  // (nur für Administratoren, kostet ein paar Token)
  if (!can(c.get('session').role, 'org.manage')) throw new HttpError(403, 'Nur für Administratoren.')
  if (!provider) return c.json({ ...status, probe: { tools: { ok: false, error: 'Kein KI-Zugang konfiguriert' }, tts: { ok: false, error: 'Kein KI-Zugang konfiguriert' } } })
  const timed = async (fn: () => Promise<string | null>) => {
    const started = Date.now()
    try {
      const error = await fn()
      return error ? { ok: false, ms: Date.now() - started, error } : { ok: true, ms: Date.now() - started }
    } catch (e) {
      return { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message.slice(0, 300) : String(e) }
    }
  }
  const tools = await timed(async () => {
    const res = await runModel({
      provider,
      instructions: 'Test: Rufe sofort das Werkzeug ping mit wert=42 auf.',
      tools: [{ type: 'function', name: 'ping', description: 'Verbindungstest', parameters: { type: 'object', properties: { wert: { type: 'integer' } }, required: ['wert'], additionalProperties: false }, strict: true }],
      input: [{ role: 'user', content: 'Test' }],
      onText: () => {},
    })
    return res.output.some((i) => i.type === 'function_call') ? null : 'Das Modell hat kein Werkzeug aufgerufen.'
  })
  const tts = !status.tts
    ? { ok: false, error: 'ausgeschaltet (JARVIS_TTS=off)' }
    : await timed(async () => {
        const res = await aiPost('/audio/speech', { model: modelId(provider, TTS_MODEL), voice: TTS_VOICE, input: 'Test.', response_format: 'pcm' }, { provider })
        const bytes = (await res.arrayBuffer()).byteLength
        return bytes > 1000 ? null : `Unerwartet kurze Antwort (${bytes} Bytes)`
      })
  return c.json({ ...status, probe: { tools, tts } })
})

jarvisRoutes.post('/jarvis/turn', requireCap('project.view'), async (c) => {
  const req = await c.req.json<JarvisTurnRequest>().catch(() => null)
  if (!req || typeof req !== 'object' || !req.input) throw new HttpError(400, 'Ungültige Anfrage.')
  const db = c.get('db')
  const session = c.get('session')
  // Proxys (z. B. Cloudflare) sollen den Stream weder puffern noch komprimieren.
  c.header('Cache-Control', 'no-cache, no-transform')
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(
    c,
    async (stream) => {
      const abort = new AbortController()
      stream.onAbort(() => abort.abort())
      let queue: Promise<unknown> = Promise.resolve()
      const emit = (e: JarvisEvent) => {
        queue = queue.then(() => (stream.aborted ? undefined : stream.writeSSE({ data: JSON.stringify(e) }))).catch(() => {})
      }
      const ping = setInterval(() => {
        queue = queue.then(() => (stream.aborted ? undefined : stream.write(': ping\n\n'))).catch(() => {})
      }, 10_000)
      try {
        await runTurn(db, session, req, emit, abort.signal)
      } finally {
        clearInterval(ping)
        await queue
      }
    },
    async (err, stream) => {
      console.error('[jarvis] Stream-Fehler', err)
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', code: 'internal', message: 'Da ist etwas schiefgegangen.' } satisfies JarvisEvent) })
    },
  )
})

/**
 * Sprachausgabe. format „pcm“ = Rohdaten (24 kHz, 16 Bit, mono) zum Abspielen schon während der
 * Erzeugung; sonst MP3. 501 = nicht verfügbar → Client nutzt die Browser-Stimme.
 */
jarvisRoutes.post('/jarvis/speak', requireCap('project.view'), async (c) => {
  const provider = getAiProvider()
  if (!provider || process.env['JARVIS_TTS'] === 'off') return c.json({ error: 'tts_unavailable' }, 501)
  const body = await c.req.json<{ text?: string; format?: string }>().catch(() => ({ text: '', format: undefined }))
  const text = String(body.text ?? '').trim().slice(0, 500)
  if (!text) throw new HttpError(400, 'Kein Text.')
  const speech = {
    model: modelId(provider, TTS_MODEL),
    voice: TTS_VOICE,
    input: text,
    instructions: 'Natürliches, lockeres Hochdeutsch – wie ein kompetenter Kollege im kurzen Gespräch, nicht wie eine Ansage. Zügiges Sprechtempo, knapp, keine gedehnten Pausen zwischen den Sätzen.',
    response_format: body.format === 'pcm' ? 'pcm' : 'mp3',
  }
  // Nicht jeder Anbieter kennt „speed“ oder PCM - dann schrittweise einfacher
  const attempts = [
    ...(TTS_SPEED !== 1 ? [{ ...speech, speed: TTS_SPEED }] : []),
    speech,
    ...(speech.response_format === 'pcm' ? [{ ...speech, response_format: 'mp3' }] : []),
  ]
  let lastError: unknown = null
  for (const attempt of attempts) {
    try {
      const res = await aiPost('/audio/speech', attempt, { provider })
      const type = attempt.response_format === 'pcm' ? 'audio/pcm' : 'audio/mpeg'
      return new Response(res.body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } })
    } catch (e) {
      lastError = e
    }
  }
  return c.json({ error: 'tts_unavailable', message: lastError instanceof Error ? lastError.message : '' }, 501)
})

/** Spracherkennung über den KI-Anbieter - für Browser ohne eingebaute Erkennung. */
jarvisRoutes.post('/jarvis/transcribe', requireCap('project.view'), async (c) => {
  const provider = getAiProvider()
  if (!provider || process.env['JARVIS_STT'] === 'off') return c.json({ error: 'stt_unavailable' }, 501)
  const form = await c.req.formData().catch(() => null)
  const audio = form?.get('audio')
  if (!audio || typeof audio === 'string' || audio.size === 0) throw new HttpError(400, 'Keine Aufnahme.')
  if (audio.size > 5 * 1024 * 1024) throw new HttpError(413, 'Die Aufnahme ist zu lang.')
  const repo = new Repo(c.get('db'))
  const orgId = c.get('session').org.id
  const names = [
    ...(await repo.members(orgId)).map((m) => m.user?.name ?? ''),
    ...(await repo.projects(orgId)).filter((p) => p.state === 'active').map((p) => p.name),
  ].filter(Boolean)
  const fd = new FormData()
  fd.append('file', audio, (audio as File).name || 'aufnahme.webm')
  fd.append('model', modelId(provider, STT_MODEL))
  fd.append('language', 'de')
  fd.append('prompt', `Terminplanung, Vorgänge, Aufgaben, Meilensteine. Namen: ${names.join(', ').slice(0, 700)}`)
  try {
    const res = await aiPost('/audio/transcriptions', fd, { provider })
    const json = (await res.json()) as { text?: string }
    return c.json({ text: String(json.text ?? '').trim() })
  } catch (e) {
    return c.json({ error: 'stt_unavailable', message: e instanceof Error ? e.message : '' }, 501)
  }
})

/** „Rückgängig“ aus der Aktionsliste - ohne Modellaufruf. */
jarvisRoutes.post('/jarvis/actions/:id/undo', requireCap('project.view'), async (c) => {
  const db = c.get('db')
  const session = c.get('session')
  const action = await getAction(db, session, c.req.param('id'))
  if (!action || action.status !== 'done' || !action.undo) throw new HttpError(404, 'Diese Aktion lässt sich nicht mehr rückgängig machen.')
  const body = await c.req.json<{ path?: unknown }>().catch(() => ({ path: undefined }))
  const path = typeof body.path === 'string' ? body.path.slice(0, 200) : '/'
  const events: JarvisEvent[] = []
  const ctx: ToolCtx = {
    db, session, today: todayISO(), emit: (e) => events.push(e), callId: 'undo', conversationId: null, writes: { count: 0 }, confirmed: null,
    context: { today: todayISO(), tz: 'Europe/Berlin', path, project_id: action.project_id, task_id: null, view: 'desktop' },
  }
  const result = await undoAction(ctx, action)
  return c.json({ ...result, events }, result.ok ? 200 : 409)
})

// Nur lokal: Werkzeug direkt ausführen (ohne Modell) - zum Testen der Werkzeuge.
if (import.meta.env?.DEV) {
  jarvisRoutes.post('/jarvis/debug/tool', async (c) => {
    const body = await c.req.json<{ name: string; arguments: Record<string, unknown>; context?: Partial<ToolCtx['context']> }>()
    const events: JarvisEvent[] = []
    const ctx: ToolCtx = {
      db: c.get('db'), session: c.get('session'), today: body.context?.today ?? todayISO(), emit: (e) => events.push(e), callId: 'debug', conversationId: null, writes: { count: 0 }, confirmed: null,
      context: { today: todayISO(), tz: 'Europe/Berlin', path: '/', project_id: null, task_id: null, view: 'desktop', ...body.context },
    }
    const result = await executeTool(ctx, body.name, body.arguments ?? {})
    return c.json({ result, events })
  })
}
