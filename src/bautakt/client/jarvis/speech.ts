/**
 * Spracherkennung für Jarvis:
 *  - CommandListener: eingebaute Erkennung des Browsers (Chrome, Edge, Safari) mit Live-Mitschrift
 *  - RecorderListener: Aufnahme + Erkennung über den Server (z. B. Firefox)
 *  - WakeListener: hört auf „Hi Jarvis“ - nur wenn der Nutzer es ausdrücklich einschaltet
 */

import { API_BASE, getToken } from '../lib/api'
import { wakeMatch } from './intents'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Recognition = any

function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === 'undefined') return null
  return ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null) as (new () => Recognition) | null
}

export function hasNativeRecognition(): boolean {
  return !!recognitionCtor()
}

export function hasRecorder(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
}

/**
 * Prüft (wo der Browser das unterstützt), ob Deutsch für die eingebaute Erkennung wirklich
 * verfügbar ist - nicht nur angefordert. Ohne diese (noch seltene) API: 'unknown', dann bleibt es
 * bei der eingebauten Erkennung; nur ein bestätigtes 'unavailable' schaltet auf den Server um,
 * damit „Hi Jarvis“ & Co. nicht versehentlich in der falschen Sprache landen.
 */
export async function germanRecognitionAvailable(): Promise<'available' | 'unavailable' | 'unknown'> {
  const Ctor = recognitionCtor() as (new () => Recognition) & { available?: (opts: { langs: string[]; processLocally?: boolean }) => Promise<string> }
  if (!Ctor || typeof Ctor.available !== 'function') return 'unknown'
  try {
    const result = await Ctor.available({ langs: ['de-DE'] })
    return result === 'unavailable' ? 'unavailable' : 'available'
  } catch {
    return 'unknown'
  }
}

export interface ListenHandlers {
  onInterim(text: string): void
  onFinal(text: string): void
  onEnd(): void
  onError(code: string): void
}

/** Stille nach dem letzten Wort, ab der ein Befehl als fertig gilt (Aufnahme-Pfad, z. B. Firefox) */
const END_OF_SPEECH_MS = 1300
/** Browser-Erkennung: so lange ohne neues Wort, dann gilt der Satz als fertig - eher großzügig,
 *  weil ein zu kurzer Wert mitten im Satz abschneidet (z. B. Denkpause bei Namen/Zahlen) und der
 *  Rest dann beim nächsten Befehl fehlt oder unverständlich bei Jarvis ankommt. */
const END_OF_WORDS_MS = 1400

export interface Listener {
  start(h: ListenHandlers, opts: { silenceMs: number; maxMs: number }): void
  stop(): void
  abort(): void
}

/** Ein Befehl per eingebauter Browser-Erkennung; endet automatisch nach der Sprechpause. */
export class CommandListener implements Listener {
  private rec: Recognition | null = null
  private finalText = ''
  private interimText = ''
  private delivered = false
  private timers: ReturnType<typeof setTimeout>[] = []

  start(h: ListenHandlers, opts: { silenceMs: number; maxMs: number }): void {
    const Ctor = recognitionCtor()
    if (!Ctor) return h.onError('unsupported')
    this.finalText = ''
    this.interimText = ''
    this.delivered = false
    const rec = new Ctor()
    this.rec = rec
    rec.lang = 'de-DE'
    rec.continuous = false
    rec.interimResults = true
    rec.maxAlternatives = 1
    let heard = false
    let quiet: ReturnType<typeof setTimeout> | null = null
    rec.onresult = (e: any) => {
      heard = true
      let fin = ''
      let interim = ''
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) fin += r[0].transcript
        else interim += r[0].transcript
      }
      this.finalText = fin
      this.interimText = interim
      h.onInterim(`${fin}${interim}`.trim())
      // Nicht auf das (oft träge) Satzende des Browsers warten
      if (quiet) clearTimeout(quiet)
      quiet = setTimeout(() => this.stop(), END_OF_WORDS_MS)
      this.timers.push(quiet)
    }
    rec.onerror = (e: any) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') h.onError(String(e.error))
    }
    rec.onend = () => {
      this.clearTimers()
      const text = `${this.finalText || this.interimText}`.trim()
      if (text && !this.delivered) {
        this.delivered = true
        h.onFinal(text)
      }
      this.rec = null
      h.onEnd()
    }
    try {
      rec.start()
    } catch {
      return h.onError('start-failed')
    }
    this.timers.push(setTimeout(() => !heard && this.stop(), opts.silenceMs))
    this.timers.push(setTimeout(() => this.stop(), opts.maxMs))
  }

  stop(): void {
    try {
      this.rec?.stop()
    } catch {
      /* bereits beendet */
    }
  }

  abort(): void {
    this.delivered = true
    this.clearTimers()
    try {
      this.rec?.abort()
    } catch {
      /* bereits beendet */
    }
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }
}

/** Aufnahme mit einfacher Pausenerkennung; die Erkennung übernimmt der Server. */
export class RecorderListener implements Listener {
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private aborted = false
  private raf = 0
  private maxTimer: ReturnType<typeof setTimeout> | null = null

  start(h: ListenHandlers, opts: { silenceMs: number; maxMs: number }): void {
    this.aborted = false
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        if (this.aborted) return stream.getTracks().forEach((t) => t.stop())
        this.stream = stream
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? ''
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
        this.recorder = recorder
        const chunks: Blob[] = []
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
        let spoke = false
        recorder.onstop = async () => {
          this.cleanup()
          if (this.aborted || !spoke || !chunks.length) return h.onEnd()
          h.onInterim('Ich höre … einen Moment.')
          try {
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
            const fd = new FormData()
            fd.append('audio', blob, `aufnahme.${blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`)
            const token = getToken()
            const res = await fetch(`${API_BASE}/api/jarvis/transcribe`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: fd })
            const json = (await res.json().catch(() => ({}))) as { text?: string }
            if (!res.ok) h.onError(res.status === 501 ? 'stt-unavailable' : 'network')
            else if (json.text) h.onFinal(json.text)
          } catch {
            h.onError('network')
          }
          h.onEnd()
        }
        recorder.start()
        // Pausenerkennung über die Lautstärke
        const ctx = new AudioContext()
        this.ctx = ctx
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        ctx.createMediaStreamSource(stream).connect(analyser)
        const data = new Uint8Array(analyser.fftSize)
        const started = performance.now()
        let lastLoud = started
        const tick = () => {
          analyser.getByteTimeDomainData(data)
          let peak = 0
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128))
          const now = performance.now()
          if (peak > 14) {
            spoke = true
            lastLoud = now
            h.onInterim('Ich höre zu …')
          }
          if ((spoke && now - lastLoud > END_OF_SPEECH_MS) || (!spoke && now - started > opts.silenceMs)) return this.stop()
          this.raf = requestAnimationFrame(tick)
        }
        this.raf = requestAnimationFrame(tick)
        this.maxTimer = setTimeout(() => this.stop(), opts.maxMs)
      })
      .catch(() => h.onError('not-allowed'))
  }

  stop(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    else this.cleanup()
  }

  abort(): void {
    this.aborted = true
    this.stop()
  }

  private cleanup(): void {
    cancelAnimationFrame(this.raf)
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.recorder = null
  }
}

/**
 * Beobachtet nur die Lautstärke des Mikrofons, während Jarvis spricht - erkennt kein Wort, nur
 * ob jemand redet. Echo Cancellation filtert Jarvis' eigene Stimme aus den Lautsprechern heraus,
 * ein kurzer Schwellwert verhindert Fehlauslöser durch einzelne Geräusche. Löst „echtes“ Barge-in
 * aus: der Nutzer unterbricht Jarvis einfach durch Reinreden, ohne das Mikrofon anzutippen.
 */
export class BargeInListener {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private raf = 0
  private active = false
  private aboveSince = 0

  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== 'undefined'
  }

  start(onSpeech: () => void): void {
    if (this.active) return
    this.active = true
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then((stream) => {
        if (!this.active) return void stream.getTracks().forEach((t) => t.stop())
        this.stream = stream
        const ctx = new AudioContext()
        this.ctx = ctx
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        ctx.createMediaStreamSource(stream).connect(analyser)
        const data = new Uint8Array(analyser.fftSize)
        this.aboveSince = 0
        const tick = () => {
          if (!this.active) return
          analyser.getByteTimeDomainData(data)
          let peak = 0
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128))
          const now = performance.now()
          if (peak > 26) {
            if (!this.aboveSince) this.aboveSince = now
            else if (now - this.aboveSince > 260) {
              this.stop()
              onSpeech()
              return
            }
          } else {
            this.aboveSince = 0
          }
          this.raf = requestAnimationFrame(tick)
        }
        this.raf = requestAnimationFrame(tick)
      })
      .catch(() => {
        this.active = false
      })
  }

  stop(): void {
    this.active = false
    cancelAnimationFrame(this.raf)
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }

  isActive(): boolean {
    return this.active
  }
}

/**
 * Hört dauerhaft auf „Hi Jarvis“ (nur wenn eingeschaltet, nur solange der Tab sichtbar ist).
 * Achtung: Die eingebaute Erkennung von Chrome/Edge verarbeitet das Audio beim Anbieter.
 */
export class WakeListener {
  private rec: Recognition | null = null
  private active = false
  private backoff = 250
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private onWake: ((rest: string) => void) | null = null
  private onDenied: (() => void) | null = null
  private readonly visibility = () => {
    if (document.hidden) this.halt()
    else if (this.active && !this.rec) this.begin()
  }

  static supported(): boolean {
    return hasNativeRecognition()
  }

  start(onWake: (rest: string) => void, onDenied: () => void): void {
    this.onWake = onWake
    this.onDenied = onDenied
    if (this.active) return
    this.active = true
    document.addEventListener('visibilitychange', this.visibility)
    this.begin()
  }

  stop(): void {
    this.active = false
    document.removeEventListener('visibilitychange', this.visibility)
    this.halt()
  }

  isActive(): boolean {
    return this.active
  }

  private halt(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const rec = this.rec
    this.rec = null
    try {
      rec?.abort()
    } catch {
      /* bereits beendet */
    }
  }

  private begin(): void {
    const Ctor = recognitionCtor()
    if (!Ctor || !this.active || document.hidden || this.rec) return
    const rec = new Ctor()
    this.rec = rec
    rec.lang = 'de-DE'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e: any) => {
      this.backoff = 250
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (!r.isFinal) continue
        const rest = wakeMatch(r[0].transcript)
        if (rest !== null) {
          this.halt()
          this.onWake?.(rest)
          return
        }
      }
    }
    rec.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.stop()
        this.onDenied?.()
      }
    }
    rec.onend = () => {
      if (this.rec !== rec) return
      this.rec = null
      if (!this.active) return
      this.restartTimer = setTimeout(() => this.begin(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 5000)
    }
    try {
      rec.start()
    } catch {
      this.rec = null
    }
  }
}
