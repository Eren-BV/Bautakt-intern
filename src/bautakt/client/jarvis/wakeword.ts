/**
 * „Hey Jarvis“ komplett im Browser (openWakeWord, ONNX): funktioniert auch in Firefox, und kein
 * Ton verlässt den Rechner. Kette wie im Original: 16-kHz-Audio in 80-ms-Blöcken → Mel-Spektrogramm
 * → Sprach-Embedding (76 Mel-Frames) → Wake-Word-Modell (16 Embeddings) → Wahrscheinlichkeit.
 * Die vortrainierten Modelle stehen unter CC BY-NC-SA 4.0 (nicht kommerziell).
 */

import type * as Ort from 'onnxruntime-web'

const MODEL_BASE = '/models/wakeword'
const TARGET_RATE = 16000
const FRAME = 1280
const MEL_CONTEXT = 480
const MEL_WINDOW = 76
const FEATURE_WINDOW = 16
const THRESHOLD = 0.5
const WARMUP_PREDICTIONS = 5

export interface WakeModels {
  ort: typeof Ort
  mel: Ort.InferenceSession
  embedding: Ort.InferenceSession
  wake: Ort.InferenceSession
}
type Models = WakeModels

/** Reine Auswertung: 80-ms-Blöcke (1280 Samples, 16 kHz, int16-Wertebereich) → Wahrscheinlichkeit 0..1. */
export class WakeDetector {
  private tail = new Float32Array(MEL_CONTEXT)
  private mel: Float32Array[] = []
  private features: Float32Array[] = []
  private predictions = 0

  constructor(private readonly m: WakeModels) {
    this.reset()
  }

  reset(): void {
    this.tail = new Float32Array(MEL_CONTEXT)
    this.mel = Array.from({ length: MEL_WINDOW }, () => new Float32Array(32).fill(1))
    this.features = []
    this.predictions = 0
  }

  async step(frame: Float32Array): Promise<number> {
    const m = this.m
    const { Tensor } = m.ort
    const audio = new Float32Array(MEL_CONTEXT + FRAME)
    audio.set(this.tail, 0)
    audio.set(frame, MEL_CONTEXT)
    this.tail = audio.slice(audio.length - MEL_CONTEXT)

    const melOut = await m.mel.run({ [m.mel.inputNames[0]!]: new Tensor('float32', audio, [1, audio.length]) })
    const spec = melOut[m.mel.outputNames[0]!]!.data as Float32Array
    for (let f = 0; f + 32 <= spec.length; f += 32) {
      const row = new Float32Array(32)
      for (let j = 0; j < 32; j++) row[j] = spec[f + j]! / 10 + 2
      this.mel.push(row)
    }
    if (this.mel.length > MEL_WINDOW) this.mel.splice(0, this.mel.length - MEL_WINDOW)

    const melWindow = new Float32Array(MEL_WINDOW * 32)
    this.mel.forEach((row, i) => melWindow.set(row, i * 32))
    const embOut = await m.embedding.run({ [m.embedding.inputNames[0]!]: new Tensor('float32', melWindow, [1, MEL_WINDOW, 32, 1]) })
    this.features.push(Float32Array.from(embOut[m.embedding.outputNames[0]!]!.data as Float32Array))
    if (this.features.length > FEATURE_WINDOW) this.features.shift()
    if (this.features.length < FEATURE_WINDOW) return 0

    const feats = new Float32Array(FEATURE_WINDOW * 96)
    this.features.forEach((f, i) => feats.set(f, i * 96))
    const wakeOut = await m.wake.run({ [m.wake.inputNames[0]!]: new Tensor('float32', feats, [1, FEATURE_WINDOW, 96]) })
    const score = (wakeOut[m.wake.outputNames[0]!]!.data as Float32Array)[0] ?? 0
    return ++this.predictions <= WARMUP_PREDICTIONS ? 0 : score
  }
}

let modelsPromise: Promise<Models> | null = null

export function loadModels(): Promise<Models> {
  modelsPromise ??= (async () => {
    const ort = await import('onnxruntime-web/wasm')
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`
    ort.env.wasm.numThreads = 1
    const opts: Ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'] }
    const [mel, embedding, wake] = await Promise.all([
      ort.InferenceSession.create(`${MODEL_BASE}/melspectrogram.onnx`, opts),
      ort.InferenceSession.create(`${MODEL_BASE}/embedding_model.onnx`, opts),
      ort.InferenceSession.create(`${MODEL_BASE}/hey_jarvis_v0.1.onnx`, opts),
    ])
    return { ort: ort as unknown as typeof Ort, mel, embedding, wake }
  })()
  modelsPromise.catch(() => {
    modelsPromise = null
  })
  return modelsPromise
}

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0 }
    }
    return true
  }
}
registerProcessor('bautakt-wake-tap', Tap)
`

/** Streamendes lineares Umrechnen auf 16 kHz, Werte im int16-Bereich (so erwartet es openWakeWord). */
export class Resampler {
  private pos = 0
  private prev = 0
  private pending: number[] = []

  constructor(private readonly ratio: number) {}

  push(input: Float32Array, out: Float32Array[]): void {
    let pos = this.pos
    for (;;) {
      const i = Math.floor(pos)
      if (i + 1 >= input.length) break
      const a = i < 0 ? this.prev : input[i]!
      const b = input[i + 1]!
      this.pending.push((a + (b - a) * (pos - i)) * 32767)
      pos += this.ratio
    }
    this.pos = pos - input.length
    this.prev = input[input.length - 1] ?? 0
    while (this.pending.length >= FRAME) out.push(Float32Array.from(this.pending.splice(0, FRAME)))
  }
}

/** Hört lokal auf „Hey Jarvis“; gleiche Schnittstelle wie der WakeListener der Browser-Erkennung. */
export class LocalWakeListener {
  private active = false
  private running = false
  private gen = 0
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private onWake: ((rest: string) => void) | null = null
  private onDenied: (() => void) | null = null
  private onFailed: (() => void) | null = null
  private frames: Float32Array[] = []
  private busy = false

  private readonly visibility = () => {
    if (document.hidden) this.halt()
    else if (this.active && !this.running) void this.begin()
  }

  static supported(): boolean {
    return (
      typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== 'undefined' &&
      typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined'
    )
  }

  start(onWake: (rest: string) => void, onDenied: () => void, onFailed?: () => void): void {
    this.onWake = onWake
    this.onDenied = onDenied
    this.onFailed = onFailed ?? null
    if (this.active) return
    this.active = true
    document.addEventListener('visibilitychange', this.visibility)
    void this.begin()
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
    this.gen++
    this.running = false
    this.frames = []
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }

  private fail(gen: number, e: unknown, what: string): void {
    console.error(`[jarvis] ${what}`, e)
    if (gen !== this.gen) return
    this.stop()
    this.onFailed?.()
  }

  private async begin(): Promise<void> {
    if (!this.active || this.running || document.hidden) return
    this.running = true
    const gen = ++this.gen
    let models: WakeModels
    try {
      models = await loadModels()
    } catch (e) {
      return this.fail(gen, e, 'Wake-Word-Modelle konnten nicht geladen werden')
    }
    if (gen !== this.gen) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch (e) {
      if (gen !== this.gen) return
      if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        this.stop()
        this.onDenied?.()
        return
      }
      return this.fail(gen, e, 'Mikrofon für das Wake-Word nicht verfügbar')
    }
    if (gen !== this.gen) return void stream.getTracks().forEach((t) => t.stop())
    this.stream = stream
    try {
      const ctx = new AudioContext()
      this.ctx = ctx
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
      await ctx.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      if (gen !== this.gen) return
      const node = new AudioWorkletNode(ctx, 'bautakt-wake-tap')
      const mute = ctx.createGain()
      mute.gain.value = 0
      ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination)
      const resampler = new Resampler(ctx.sampleRate / TARGET_RATE)
      const detector = new WakeDetector(models)
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (gen !== this.gen) return
        resampler.push(e.data, this.frames)
        // Kommt die Auswertung nicht hinterher, lieber alte Blöcke verwerfen als Sekunden zu spät reagieren
        if (this.frames.length > 12) this.frames.splice(0, this.frames.length - 12)
        void this.drain(detector, gen)
      }
    } catch (e) {
      this.fail(gen, e, 'Wake-Word-Audio konnte nicht gestartet werden')
    }
  }

  private async drain(detector: WakeDetector, gen: number): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while (this.frames.length && gen === this.gen) {
        const score = await detector.step(this.frames.shift()!)
        if (gen !== this.gen) return
        if (score >= THRESHOLD) {
          this.halt()
          this.onWake?.('')
          return
        }
      }
    } catch (e) {
      this.fail(gen, e, 'Wake-Word-Auswertung fehlgeschlagen')
    } finally {
      this.busy = false
    }
  }
}
