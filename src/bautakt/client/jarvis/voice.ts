/**
 * Sprachausgabe von Jarvis. Text wird satzweise gesprochen, sobald er ankommt (geringe Latenz).
 * Bevorzugt die natürliche KI-Stimme (/api/jarvis/speak), sonst die Stimme des Browsers.
 */

import { API_BASE, getToken } from '../lib/api'

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
const WEEKDAYS: Record<string, string> = { Mo: 'Montag', Di: 'Dienstag', Mi: 'Mittwoch', Do: 'Donnerstag', Fr: 'Freitag', Sa: 'Samstag', So: 'Sonntag' }
const month = (m: string) => MONTHS[Number(m) - 1] ?? m

/** Text für die Sprachausgabe aufbereiten: Datumsformate, Abkürzungen, Sonderzeichen. */
export function speakable(text: string): string {
  return text
    .replace(/[*#_`]/g, '')
    .replace(/[„“”"»«]/g, '')
    .replace(/(\d{1,2}\.\d{1,2}\.)\s*[–-]\s*(?=(?:Mo|Di|Mi|Do|Fr|Sa|So)?\s?\d{1,2}\.\d{1,2}\.)/g, '$1 bis ')
    .replace(/\b(Mo|Di|Mi|Do|Fr|Sa|So) (\d{1,2})\.(\d{1,2})\.(\d{4})?/g, (_, wd: string, d: string, m: string, y?: string) => `${WEEKDAYS[wd]}, ${Number(d)}. ${month(m)}${y ? ` ${y}` : ''}`)
    .replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g, (_, d: string, m: string, y: string) => `${Number(d)}. ${month(m)} ${y}`)
    .replace(/\b(\d{1,2})\.(\d{1,2})\.(?!\d)/g, (_, d: string, m: string) => `${Number(d)}. ${month(m)}`)
    .replace(/\+(\d)/g, 'plus $1')
    .replace(/\b1 AT\b/g, 'ein Arbeitstag')
    .replace(/(\d+) AT\b/g, '$1 Arbeitstage')
    .replace(/\bAT\b/g, 'Arbeitstage')
    .replace(/\s*·\s*/g, ', ')
    .replace(/\s+–\s+/g, ', ')
    .replace(/\s*→\s*/g, ' auf ')
    .replace(/%/g, ' Prozent')
    .replace(/&/g, ' und ')
    .replace(/\bz\. ?B\./g, 'zum Beispiel')
    .replace(/\bbzw\./g, 'beziehungsweise')
    .replace(/\bca\./g, 'circa')
    .replace(/\bNr\./g, 'Nummer')
    .replace(/\bu\. ?a\./g, 'unter anderem')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const MAX_CHARS_PER_TURN = 600
/** So lange wird höchstens auf die KI-Stimme eines Satzes gewartet */
const AUDIO_WAIT_MS = 6000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const ABBREVIATION = /(?:^|[\s(])(?:[a-zäöü]|ca|bzw|nr|ggf|evtl|inkl|max|min|str|hr|dr|vgl|usw|ua|zb)\.$/i

/** Position nach dem ersten sicheren Satzende - nicht bei „12. Oktober“ oder Abkürzungen. */
function sentenceEnd(s: string): number {
  const re = /[.!?…]+(?=\s|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const upto = s.slice(0, m.index + 1)
    if (m[0][0] === '.' && (/\d\.$/.test(upto) || ABBREVIATION.test(upto))) continue
    return m.index + m[0].length
  }
  return -1
}

/** 24 kHz, 16 Bit, mono - so liefert der KI-Dienst Rohdaten („pcm“) */
const PCM_RATE = 24_000

type QueueItem = {
  text: string
  /** Ganze Audiodatei (MP3) */
  audio: Promise<Blob | null> | null
  /** Oder: Rohdaten-Stream, der schon während der Erzeugung abgespielt wird */
  stream?: { response: Promise<Response | null>; abort: AbortController }
}

let greetingBlob: Blob | null = null

export class VoiceOut {
  mode: 'cloud' | 'browser' = 'cloud'
  enabled = true
  /** Meldet, wenn Jarvis zu sprechen beginnt bzw. fertig ist */
  onActivity: ((speaking: boolean) => void) | null = null
  private queue: QueueItem[] = []
  private playing = false
  private buffer = ''
  private spokenChars = 0
  private generation = 0
  private ctx: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private pcmSources = new Set<AudioBufferSourceNode>()
  private current: HTMLAudioElement | null = null
  private aborters = new Set<AbortController>()
  private cloudBroken = false
  private idleWaiters: (() => void)[] = []

  /**
   * Muss in einer Nutzeraktion (Klick, Taste) aufgerufen werden: Danach darf die Seite Töne
   * abspielen - auch auf dem iPhone und ohne dass jede Antwort erneut einen Klick braucht.
   */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctor) return
        this.ctx = new Ctor()
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
    } catch {
      this.ctx = null
    }
  }

  /** Kurzer Signalton: aufsteigend = ich höre zu, absteigend = ich höre nicht mehr zu. */
  tone(kind: 'up' | 'down'): void {
    const ctx = this.ctx
    if (!ctx || ctx.state !== 'running') return
    const notes = kind === 'up' ? [660, 880] : [700, 520]
    notes.forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.09
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.06, t + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.09)
    })
  }

  begin(): void {
    this.buffer = ''
    this.spokenChars = 0
  }

  /** Neuer Text aus dem Stream - vollständige Sätze werden sofort eingereiht. */
  feed(delta: string): void {
    if (!this.enabled) return
    this.buffer += delta
    for (;;) {
      let cut = sentenceEnd(this.buffer)
      if (cut < 0 && this.buffer.length > 180) {
        const comma = this.buffer.lastIndexOf(', ', 180)
        if (comma > 40) cut = comma + 1
      }
      if (cut < 0) break
      const sentence = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut)
      this.enqueue(sentence)
    }
  }

  end(): void {
    if (this.buffer.trim()) this.enqueue(this.buffer)
    this.buffer = ''
  }

  /** Kurzer, fester Satz („Einen Moment.“, Fehlermeldung) - unabhängig von der Längengrenze */
  say(text: string): void {
    if (this.enabled) this.enqueue(text, true)
  }

  /** Begrüßung sofort und ohne Wartezeit (zwischengespeichert). */
  greet(text: string): void {
    if (!this.enabled) return
    if (greetingBlob && this.mode === 'cloud' && !this.cloudBroken) {
      this.queue.push({ text, audio: Promise.resolve(greetingBlob) })
      void this.pump()
      return
    }
    this.enqueue(text, true)
  }

  /** Begrüßung vorab laden, damit „Ja Boss …“ ohne Verzögerung kommt. */
  async preloadGreeting(text: string): Promise<void> {
    if (greetingBlob || this.mode !== 'cloud' || this.cloudBroken) return
    greetingBlob = await this.fetchAudio(speakable(text)).catch(() => null)
  }

  stop(): void {
    this.generation++
    for (const a of this.aborters) a.abort()
    this.aborters.clear()
    this.queue = []
    this.buffer = ''
    for (const src of [this.source, ...this.pcmSources]) {
      try {
        src?.stop()
      } catch {
        /* bereits beendet */
      }
    }
    this.source = null
    this.pcmSources = new Set()
    if (this.current) {
      this.current.pause()
      this.current.src = ''
      this.current = null
    }
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
    const wasPlaying = this.playing
    this.playing = false
    this.flushIdle()
    if (wasPlaying) this.onActivity?.(false)
  }

  isSpeaking(): boolean {
    return this.playing || this.queue.length > 0
  }

  /** Wartet, bis alles Gesagte zu Ende gesprochen ist. */
  whenIdle(): Promise<void> {
    if (!this.isSpeaking()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private flushIdle(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const w of waiters) w()
  }

  private enqueue(raw: string, force = false): void {
    const text = speakable(raw)
    if (!text) return
    if (!force && this.spokenChars >= MAX_CHARS_PER_TURN) return
    this.spokenChars += text.length
    const useCloud = this.mode === 'cloud' && !this.cloudBroken
    // Ton freigeschaltet: Rohdaten streamen - Jarvis spricht, sobald die ersten Daten da sind
    if (useCloud && this.ctx?.state === 'running') this.queue.push({ text, audio: null, stream: this.openStream(text) })
    else this.queue.push({ text, audio: useCloud ? this.fetchAudio(text).catch(() => null) : null })
    void this.pump()
  }

  private openStream(text: string): NonNullable<QueueItem['stream']> {
    const abort = new AbortController()
    this.aborters.add(abort)
    const token = getToken()
    const response = fetch(`${API_BASE}/api/jarvis/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text, format: 'pcm' }),
      signal: abort.signal,
    })
      .then((res) => {
        if (res.ok && (res.headers.get('content-type') ?? '').startsWith('audio/')) return res
        if (res.status === 501) this.cloudBroken = true
        this.aborters.delete(abort)
        return null
      })
      .catch(() => {
        this.aborters.delete(abort)
        return null
      })
    return { response, abort }
  }

  private async fetchAudio(text: string): Promise<Blob | null> {
    const ctrl = new AbortController()
    this.aborters.add(ctrl)
    try {
      const token = getToken()
      const res = await fetch(`${API_BASE}/api/jarvis/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text }),
        signal: ctrl.signal,
      })
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('audio/')) {
        if (res.status === 501) this.cloudBroken = true
        return null
      }
      return await res.blob()
    } finally {
      this.aborters.delete(ctrl)
    }
  }

  private async pump(): Promise<void> {
    if (this.playing) return
    this.playing = true
    const generation = this.generation
    this.onActivity?.(true)
    try {
      // stop() leert die Warteschlange und erhöht die Generation - dann endet diese Schleife
      while (this.queue.length && generation === this.generation) {
        const item = this.queue[0]!
        if (item.stream) await this.playStreamItem(item.text, item.stream, generation)
        else {
          // Hängt die KI-Stimme, spricht für diesen Satz die Stimme des Geräts - besser als lange Stille
          const blob = item.audio ? await withTimeout(item.audio, AUDIO_WAIT_MS) : null
          if (generation !== this.generation) break
          if (blob) await this.playBlob(blob, generation)
          else await this.playBrowser(item.text, generation)
        }
        if (generation !== this.generation) break
        this.queue.shift()
      }
    } finally {
      // stop() hat den Zustand bereits zurückgesetzt, falls die Wiedergabe abgebrochen wurde
      if (generation === this.generation) {
        this.playing = false
        if (!this.queue.length) this.flushIdle()
        this.onActivity?.(false)
      }
    }
  }

  private async playStreamItem(text: string, stream: NonNullable<QueueItem['stream']>, generation: number): Promise<void> {
    const res = await withTimeout(stream.response, AUDIO_WAIT_MS)
    if (generation !== this.generation) return
    try {
      if (!res) {
        // Keine KI-Stimme (Fehler oder zu langsam): diesen Satz mit der Stimme des Geräts
        stream.abort.abort()
        return await this.playBrowser(text, generation)
      }
      if ((res.headers.get('content-type') ?? '').startsWith('audio/pcm')) return await this.playPcm(res, generation)
      // Anbieter liefert kein PCM: dann als ganze MP3-Datei
      const blob = await res.blob().catch(() => null)
      if (generation !== this.generation) return
      if (blob) await this.playBlob(blob, generation)
      else await this.playBrowser(text, generation)
    } finally {
      this.aborters.delete(stream.abort)
    }
  }

  /** Rohdaten stückweise und lückenlos einplanen, sobald sie ankommen. */
  private async playPcm(res: Response, generation: number): Promise<void> {
    const ctx = this.ctx
    if (!ctx || !res.body) return
    const reader = res.body.getReader()
    const sources = this.pcmSources
    let at = 0
    let carry: Uint8Array | null = null
    let lastEnded: Promise<void> = Promise.resolve()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || generation !== this.generation) break
        let bytes = value
        if (carry) {
          const merged = new Uint8Array(carry.length + bytes.length)
          merged.set(carry)
          merged.set(bytes, carry.length)
          bytes = merged
          carry = null
        }
        // 16-Bit-Werte dürfen nicht über Stückgrenzen zerrissen werden
        const even = bytes.length - (bytes.length % 2)
        if (even < bytes.length) carry = bytes.slice(even)
        if (!even) continue
        const pcm = new Int16Array(bytes.slice(0, even).buffer)
        const buffer = ctx.createBuffer(1, pcm.length, PCM_RATE)
        const channel = buffer.getChannelData(0)
        for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i]! / 32768
        const src = ctx.createBufferSource()
        src.buffer = buffer
        src.connect(ctx.destination)
        // Beim ersten Stück minimal puffern (gleicht Netzschwankungen aus), danach nahtlos anschließen
        at = Math.max(at, ctx.currentTime + (at === 0 ? 0.12 : 0.02))
        src.start(at)
        at += buffer.duration
        sources.add(src)
        lastEnded = new Promise<void>((resolve) => {
          src.onended = () => {
            sources.delete(src)
            resolve()
          }
        })
      }
    } catch {
      /* abgebrochen */
    }
    if (generation === this.generation) await lastEnded
  }

  private async playBlob(blob: Blob, generation: number): Promise<void> {
    const ctx = this.ctx
    if (ctx && ctx.state === 'running') {
      try {
        const buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
        if (generation !== this.generation) return
        await new Promise<void>((resolve) => {
          const src = ctx.createBufferSource()
          src.buffer = buffer
          src.connect(ctx.destination)
          this.source = src
          src.onended = () => {
            if (this.source === src) this.source = null
            resolve()
          }
          src.start()
        })
        return
      } catch {
        /* Dekodieren fehlgeschlagen - dann über das Audio-Element */
      }
    }
    return this.playElement(blob, generation)
  }

  private playElement(blob: Blob, generation: number): Promise<void> {
    return new Promise((resolve) => {
      if (generation !== this.generation) return resolve()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      this.current = audio
      const done = () => {
        URL.revokeObjectURL(url)
        if (this.current === audio) this.current = null
        resolve()
      }
      audio.onended = done
      audio.onerror = done
      audio.play().catch(() => {
        // Autoplay blockiert (noch keine Nutzerinteraktion) - dann eben nur als Text
        done()
      })
    })
  }

  private playBrowser(text: string, generation: number): Promise<void> {
    return new Promise((resolve) => {
      if (generation !== this.generation || typeof speechSynthesis === 'undefined') return resolve()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'de-DE'
      u.rate = 1.05
      const voice = pickGermanVoice()
      if (voice) u.voice = voice
      u.onend = () => resolve()
      u.onerror = () => resolve()
      speechSynthesis.speak(u)
    })
  }
}

function pickGermanVoice(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('de'))
  const prefer = [/natural/i, /online/i, /google/i, /katja|conrad|anna|markus|hedda|stefan/i]
  for (const re of prefer) {
    const hit = voices.find((v) => re.test(v.name))
    if (hit) return hit
  }
  return voices[0] ?? null
}
