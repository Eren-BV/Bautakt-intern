/**
 * Eine Jarvis-Runde als Server-Sent-Events lesen (POST mit Anmeldung, daher kein EventSource).
 * Wird nie automatisch wiederholt: Eine Runde kann bereits etwas geändert haben.
 */

import { API_BASE, getToken } from '../lib/api'
import type { JarvisEvent, JarvisTurnRequest } from '../../shared/jarvis/protocol'

const STALL_MS = 45_000

export async function* streamTurn(req: JarvisTurnRequest, signal: AbortSignal): AsyncGenerator<JarvisEvent> {
  const token = getToken()
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api/jarvis/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(req),
      signal,
    })
  } catch {
    if (!signal.aborted) yield { type: 'error', code: 'internal', message: 'Keine Verbindung zum Server.' }
    return
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    const code = res.status === 401 || res.status === 403 ? 'forbidden' : res.status === 429 ? 'rate_limited' : 'internal'
    yield { type: 'error', code, message: data?.error ?? `Fehler ${res.status}` }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finished = false
  try {
    for (;;) {
      // Der Server sendet alle 10 s ein Lebenszeichen - bleibt es länger aus, hängt die Verbindung
      let timer: ReturnType<typeof setTimeout> | undefined
      const stalled = new Promise<'stalled'>((resolve) => (timer = setTimeout(() => resolve('stalled'), STALL_MS)))
      const next = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer))
      if (next === 'stalled') break
      const { value, done } = next
      if (done) break
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        // Kommentare (": ping") und Leerblöcke überspringen
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n')
        if (!data) continue
        let evt: JarvisEvent
        try {
          evt = JSON.parse(data) as JarvisEvent
        } catch {
          continue
        }
        if (evt.type === 'done' || evt.type === 'error') finished = true
        yield evt
      }
    }
  } catch {
    if (signal.aborted) return
  } finally {
    void reader.cancel().catch(() => {})
  }
  if (!finished && !signal.aborted) yield { type: 'error', code: 'internal', message: 'Die Verbindung wurde unterbrochen.' }
}
