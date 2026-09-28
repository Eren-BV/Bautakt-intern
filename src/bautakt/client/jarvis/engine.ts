/**
 * Jarvis im Browser: Gesprächszustand, der Ablauf Zuhören → Denken → Sprechen, Bestätigungen,
 * Rückgängig und die sichtbaren Folgen (Seitenwechsel, Vorgang im Plan zeigen).
 * Ein einziges Objekt auf globalThis - es überlebt Seitenwechsel und das Neuaufbauen des App-Baums,
 * eine laufende Antwort bricht also nicht ab, wenn Jarvis selbst die Seite wechselt.
 */

import { useSyncExternalStore } from 'react'
import { navigate } from '../lib/router'
import { API_BASE, getToken } from '../lib/api'
import type { JarvisConfirmation, JarvisContext, JarvisEvent, JarvisItem, JarvisTurnRequest, JarvisUiEvent } from '../../shared/jarvis/protocol'
import * as bus from './bus'
import { confirmationAnswer, isStop, isThanks } from './intents'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type JarvisSettings } from './settings'
import { CommandListener, RecorderListener, WakeListener, germanRecognitionAvailable, hasNativeRecognition, hasRecorder, type Listener } from './speech'
import { streamTurn } from './stream'
import { VoiceOut } from './voice'

export const GREETING = 'Ja Boss, wo kann ich helfen?'

const SESSION_KEY = 'bautakt.jarvis.session'
/** Nach so langer Pause beginnt ein neues Gespräch */
const CONVERSATION_IDLE_MS = 30 * 60_000
/** Nach so langer Pause begrüßt Jarvis wieder mit „Ja Boss …“ */
const GREET_AGAIN_MS = 5 * 60_000
/** „Hi Jarvis“ pausiert, wenn so lange niemand die Seite bedient */
const WAKE_IDLE_MS = 15 * 60_000
const MAX_MESSAGES = 60
const MAX_HISTORY_ITEMS = 60
const MAX_HISTORY_CHARS = 30_000
/** Werkzeuge, bei denen der Seitenwechsel ausdrücklich gewünscht bzw. nötig ist */
const EXPLICIT_NAV_TOOLS = new Set(['show', 'create_project', 'undo_last', 'undo'])
const PROJECT_PAGES = 'gantt|tasks|lookahead|milestones|baseline|scenarios|reports|history|settings|trades|proposals'
const ALLOWED_PATHS = [
  /^\/(projects|portfolio|site|inbox|notifications|team|schedule|lookahead|milestones|resources|calendar|templates|reports|settings)?$/,
  new RegExp(`^/projects/[\\w-]+(/(${PROJECT_PAGES}))?(\\?[\\w=&%.-]*)?$`),
]

export type JarvisPhase = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface JarvisStep {
  id: string
  label: string
  /** waiting = Bestätigung offen, question = Rückfrage (mehrdeutig/nicht gefunden), cancelled = abgelehnt */
  status: 'running' | 'ok' | 'error' | 'waiting' | 'question' | 'cancelled'
  action_id?: string
  undoable?: boolean
  undo?: 'running' | 'done'
  link?: { label: string; to: string }
}

export interface JarvisMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  via?: 'voice' | 'text'
  steps: JarvisStep[]
  /** „Im Plan ansehen“, wenn Jarvis die Ansicht nicht selbst wechseln durfte */
  link?: { label: string; to: string }
  pending?: boolean
  error?: boolean
}

export interface JarvisConfirmState extends JarvisConfirmation {
  state: 'open' | 'sending' | 'expired'
}

export interface JarvisState {
  ready: boolean
  open: boolean
  minimized: boolean
  phase: JarvisPhase
  messages: JarvisMessage[]
  interim: string
  confirm: JarvisConfirmState | null
  notice: { tone: 'info' | 'error'; text: string } | null
  settings: JarvisSettings
  wake: 'off' | 'on' | 'paused'
  mic: 'native' | 'recorder' | 'none'
  server: { ai: boolean; tts: boolean; stt: boolean } | null
  /** Zähler: Das Panel setzt den Fokus ins Textfeld, sobald er sich ändert */
  focusInput: number
  /** Für die pro Nutzer gespeicherte Fenstergröße/-position des Panels */
  userId: string | null
}

interface Job {
  text: string
  via: 'voice' | 'text'
  confirm: JarvisTurnRequest['confirm']
  /** Text der Sprechblase des Nutzers (leer = keine Sprechblase) */
  display: string
}

interface TurnState {
  id: string
  via: 'voice' | 'text'
  speak: boolean
  spoke: boolean
  momentSaid: boolean
  momentTimer: ReturnType<typeof setTimeout> | null
  tool: string | null
  navigated: Set<string>
  expectsReply: boolean
  replyId: string
}

const INITIAL: JarvisState = {
  ready: false, open: false, minimized: false, phase: 'idle', messages: [], interim: '', confirm: null, notice: null,
  settings: DEFAULT_SETTINGS, wake: 'off', mic: 'none', server: null, focusInput: 0, userId: null,
}

class JarvisEngine {
  private state: JarvisState = INITIAL
  private readonly subscribers = new Set<() => void>()
  private user: { id: string; orgId: string } | null = null
  private attached = 0
  private detachTimer: ReturnType<typeof setTimeout> | null = null
  private conversationId = newId('c')
  private history: JarvisItem[] = []
  private lastTurnAt = 0
  private lastVia: 'voice' | 'text' = 'text'
  private lastExpectsReply = false
  private readonly voice = new VoiceOut()
  private readonly wakeListener = new WakeListener()
  private wakePaused = false
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private idleCheck: ReturnType<typeof setInterval> | null = null
  private lastUserActivity = Date.now()
  private listener: Listener | null = null
  private forceRecorder = false
  private queue: Job[] = []
  private busy = false
  private drainGen = 0
  private greetGen = 0
  private turn: TurnState | null = null
  private turnAbort: AbortController | null = null
  private draft = false

  constructor() {
    this.voice.onActivity = (speaking) => {
      this.refreshPhase()
      if (!speaking) this.syncWake(2000)
    }
  }

  // ------------------------------------------------------------ Zustand

  getState = (): JarvisState => this.state

  subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  private set(patch: Partial<JarvisState>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of this.subscribers) fn()
  }

  private refreshPhase(): void {
    const phase: JarvisPhase = this.listener ? 'listening' : this.voice.isSpeaking() ? 'speaking' : this.busy ? 'thinking' : 'idle'
    if (phase !== this.state.phase) this.set({ phase })
  }

  // ------------------------------------------------------------ Anmeldung / Lebenszyklus

  /** Von JarvisRoot nach der Anmeldung aufgerufen; ein anderer Nutzer beginnt von vorn. */
  configure(user: { userId: string; orgId: string }): void {
    if (this.user?.id === user.userId && this.user.orgId === user.orgId) return
    this.reset()
    this.user = { id: user.userId, orgId: user.orgId }
    this.state = { ...INITIAL, ready: true, settings: loadSettings(user.userId), mic: this.detectMic(null), userId: user.userId }
    this.restore()
    this.applyVoiceSettings()
    this.set({})
    void this.loadStatus()
    void this.checkGermanSupport()
    this.idleCheck = setInterval(() => {
      if (!this.wakePaused && this.state.settings.wakeWord && Date.now() - this.lastUserActivity > WAKE_IDLE_MS) {
        this.wakePaused = true
        this.syncWake()
      }
    }, 60_000)
  }

  /** JarvisRoot ist eingehängt. Ohne erneutes Einhängen (Abmelden) wird alles gestoppt. */
  attach(): () => void {
    this.attached++
    if (this.detachTimer) clearTimeout(this.detachTimer)
    this.detachTimer = null
    this.syncWake(500)
    return () => {
      this.attached--
      if (this.attached > 0) return
      // Beim Seitenwechsel wird der App-Baum teils neu aufgebaut - erst nach kurzer Zeit aufräumen
      this.detachTimer = setTimeout(() => {
        this.detachTimer = null
        if (this.attached === 0) this.reset()
      }, 1500)
    }
  }

  dispose(): void {
    this.reset()
  }

  private reset(): void {
    this.turnAbort?.abort()
    this.turnAbort = null
    this.queue = []
    this.busy = false
    this.turn = null
    this.drainGen++
    this.greetGen++
    this.cancelListening()
    this.voice.stop()
    this.wakeListener.stop()
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    if (this.idleCheck) clearInterval(this.idleCheck)
    this.wakeTimer = null
    this.idleCheck = null
    this.user = null
    this.history = []
    this.conversationId = newId('c')
    this.lastTurnAt = 0
    this.forceRecorder = false
    this.state = INITIAL
    this.set({})
  }

  private async loadStatus(): Promise<void> {
    const user = this.user
    let server: NonNullable<JarvisState['server']>
    try {
      const res = await fetch(`${API_BASE}/api/jarvis/status`, { headers: authHeaders() })
      const json = (await res.json()) as { ai?: boolean; tts?: boolean; stt?: boolean }
      server = { ai: !!json.ai, tts: !!json.tts, stt: !!json.stt }
    } catch {
      server = { ai: false, tts: false, stt: false }
    }
    if (user !== this.user) return
    this.set({ server, mic: this.detectMic(server) })
    this.applyVoiceSettings()
    this.syncWake(500)
  }

  /**
   * Wo der Browser es verrät: sicherstellen, dass die eingebaute Erkennung wirklich Deutsch kann,
   * bevor sie überhaupt eingesetzt wird - sonst lieber gleich der zuverlässige Server-Weg.
   */
  private async checkGermanSupport(): Promise<void> {
    const user = this.user
    const support = await germanRecognitionAvailable()
    if (support !== 'unavailable' || user !== this.user) return
    this.forceRecorder = true
    this.set({ mic: this.detectMic(this.state.server) })
    this.syncWake()
  }

  private detectMic(server: JarvisState['server']): JarvisState['mic'] {
    if (hasNativeRecognition() && !this.forceRecorder) return 'native'
    if (hasRecorder() && server?.stt !== false) return 'recorder'
    return 'none'
  }

  private applyVoiceSettings(): void {
    const { speak, voice } = this.state.settings
    this.voice.enabled = speak
    this.voice.mode = voice === 'cloud' && this.state.server?.tts !== false ? 'cloud' : 'browser'
    if (speak && this.voice.mode === 'cloud' && this.state.server?.tts) void this.voice.preloadGreeting(GREETING)
  }

  setSettings(patch: Partial<JarvisSettings>): void {
    const settings = { ...this.state.settings, ...patch }
    if (this.user) saveSettings(this.user.id, settings)
    if (patch.wakeWord) this.wakePaused = false
    this.set({ settings })
    this.applyVoiceSettings()
    if (!settings.speak) this.voice.stop()
    this.syncWake(300)
  }

  /** Jede Bedienung der Seite (Klick, Taste) - hält „Hi Jarvis“ wach. */
  touch(): void {
    this.lastUserActivity = Date.now()
    if (this.wakePaused) {
      this.wakePaused = false
      this.syncWake(300)
    }
  }

  // ------------------------------------------------------------ „Hi Jarvis“

  wakeSupported(): boolean {
    // Nur am Computer (piept sonst dauernd und kostet Akku) und nur, wenn die eingebaute Erkennung
    // bestätigt Deutsch kann - sonst würde „Hi Jarvis“ zuverlässig in der falschen Sprache landen.
    return WakeListener.supported() && !this.forceRecorder && typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches
  }

  private wakeWanted(): boolean {
    return (
      this.state.ready && this.attached > 0 && this.state.settings.wakeWord && this.wakeSupported() && !this.wakePaused &&
      !this.listener && !this.busy && !this.voice.isSpeaking()
    )
  }

  private syncWake(delayMs = 0): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    if (!this.wakeWanted()) {
      if (this.wakeListener.isActive()) this.wakeListener.stop()
    } else if (!this.wakeListener.isActive()) {
      const start = () => {
        this.wakeTimer = null
        if (!this.wakeWanted() || this.wakeListener.isActive()) return
        this.wakeListener.start(
          (rest) => this.onWake(rest),
          () => {
            this.setSettings({ wakeWord: false })
            this.set({ notice: { tone: 'error', text: 'Das Mikrofon ist blockiert – „Hi Jarvis“ wurde ausgeschaltet.' } })
          },
        )
      }
      if (delayMs > 0) this.wakeTimer = setTimeout(start, delayMs)
      else start()
    }
    const wake = !this.state.settings.wakeWord || !this.wakeSupported() ? 'off' : this.wakePaused ? 'paused' : 'on'
    if (wake !== this.state.wake) this.set({ wake })
  }

  private onWake(rest: string): void {
    this.touch()
    this.rollConversation()
    this.set({ open: true, minimized: false, notice: null })
    const words = rest.split(' ').filter(Boolean)
    // „Hi Jarvis, verschieb den Estrich um zwei Tage“ - ohne Begrüßung direkt loslegen
    if (words.length >= 3 || (words.length && (isStop(rest) || isThanks(rest) || confirmationAnswer(rest)))) {
      this.handleInput(rest, 'voice')
      return
    }
    this.greetThenListen()
  }

  // ------------------------------------------------------------ Bedienung

  /** Jarvis-Knopf oder Alt+J (immer eine Nutzeraktion). */
  activate(): void {
    if (!this.state.ready) return
    this.touch()
    this.voice.unlock()
    if (this.listener) {
      // Zweiter Druck: Zuhören beenden - das bisher Gesagte wird noch ausgewertet
      this.listener.stop()
      return
    }
    const interrupted = this.voice.isSpeaking()
    this.interruptSpeech()
    this.rollConversation()
    this.set({ open: true, minimized: false, notice: null })
    if (this.state.mic === 'none') {
      this.set({ focusInput: this.state.focusInput + 1 })
      return
    }
    if (!interrupted && this.shouldGreet()) this.greetThenListen()
    else this.listen('command')
  }

  /** Mikrofon-Knopf im Panel: zuhören bzw. Zuhören beenden (ohne Begrüßung). */
  toggleListening(): void {
    this.voice.unlock()
    this.touch()
    if (this.listener) return this.listener.stop()
    this.interruptSpeech()
    this.listen('command')
  }

  sendText(text: string): void {
    this.voice.unlock()
    this.handleInput(text, 'text')
  }

  /** Esc: erst Sprache und Zuhören stoppen, dann (nur mit Fokus im Panel) schließen. */
  escape(): void {
    if (this.listener || this.voice.isSpeaking()) return this.stopAll()
    const active = document.activeElement as HTMLElement | null
    if (this.state.open && active?.closest('[data-jarvis]')) this.close()
  }

  /** Stopp: sofort still sein und nicht mehr zuhören - eine laufende Runde endet still. */
  stopAll(): void {
    this.interruptSpeech()
    this.cancelListening()
    this.refreshPhase()
    this.syncWake(1000)
  }

  close(): void {
    this.stopAll()
    this.set({ open: false, minimized: false, notice: null })
  }

  setMinimized(minimized: boolean): void {
    this.set({ open: true, minimized })
  }

  /** Das Textfeld enthält einen Entwurf - dann nicht automatisch weiter zuhören. */
  setDraft(active: boolean): void {
    this.draft = active
  }

  dismissNotice(): void {
    this.set({ notice: null })
  }

  newConversation(): void {
    if (this.busy) return
    this.interruptSpeech()
    this.cancelListening()
    this.startConversation()
    this.refreshPhase()
  }

  testVoice(): void {
    this.voice.unlock()
    this.interruptSpeech()
    const enabled = this.voice.enabled
    this.voice.enabled = true
    this.voice.begin()
    this.voice.say('Hallo Boss, ich bin Jarvis. So klinge ich.')
    this.voice.enabled = enabled
  }

  /** Nur zum Testen (Entwicklung): so tun, als wäre „Hi Jarvis …“ gesagt worden. */
  simulateWake(rest = ''): void {
    this.onWake(rest)
  }

  // ------------------------------------------------------------ Gespräch

  private shouldGreet(): boolean {
    return this.state.messages.length === 0 || Date.now() - this.lastTurnAt > GREET_AGAIN_MS
  }

  /** Nach langer Pause ein neues Gespräch beginnen (kleiner Kontext, eindeutiges „rückgängig“). */
  private rollConversation(): void {
    if (this.busy || !this.lastTurnAt || Date.now() - this.lastTurnAt < CONVERSATION_IDLE_MS) return
    this.startConversation()
  }

  private startConversation(): void {
    this.conversationId = newId('c')
    this.history = []
    this.lastTurnAt = 0
    this.set({ messages: [], confirm: null, notice: null })
    this.persist()
  }

  private greetThenListen(): void {
    const gen = ++this.greetGen
    this.wakeListener.stop()
    const last = this.state.messages.at(-1)
    if (!(last?.role === 'assistant' && last.text === GREETING)) this.pushMessage({ role: 'assistant', text: GREETING })
    if (!this.state.settings.speak) return this.listen('command')
    this.voice.begin()
    this.voice.greet(GREETING)
    void this.voice.whenIdle().then(() => {
      if (gen === this.greetGen && !this.listener && !this.busy && this.state.open) this.listen('command')
    })
  }

  private interruptSpeech(): void {
    this.greetGen++
    this.voice.stop()
    if (this.turn) this.turn.speak = false
  }

  /** Gesprochener oder getippter Satz des Nutzers. */
  handleInput(raw: string, via: 'voice' | 'text'): void {
    const text = raw.trim()
    if (!text || !this.state.ready) return
    this.touch()
    this.greetGen++
    this.rollConversation()
    this.set({ open: true, notice: null })
    // Offene Bestätigung: „ja“ / „nein“ / „abbrechen“ direkt beantworten - ohne KI
    if (this.state.confirm?.state === 'open') {
      const answer = confirmationAnswer(text)
      if (answer) return this.decide(answer === 'yes' ? 'confirm' : 'cancel', text, via)
    }
    if (isStop(text)) return this.stopAll()
    if (isThanks(text) && !this.busy && !this.queue.length) {
      const reply = 'Gerne, Boss.'
      this.pushMessage({ role: 'user', text, via })
      this.pushMessage({ role: 'assistant', text: reply })
      this.history = trimHistory([...this.history, { role: 'user', content: text }, { role: 'assistant', content: reply }])
      this.persist()
      if (via === 'voice' && this.state.settings.speak) this.voice.say(reply)
      const gen = this.greetGen
      void this.voice.whenIdle().then(() =>
        setTimeout(() => {
          if (gen === this.greetGen && !this.busy && !this.listener) this.set({ open: false })
        }, 700),
      )
      return
    }
    this.submit({ text, via, confirm: null, display: text })
  }

  /** Antwort auf die Bestätigungskarte - per Knopf, Sprache oder Text. Nur der Nutzer bestätigt. */
  decide(decision: 'confirm' | 'cancel', text = '', via?: 'voice' | 'text'): void {
    const card = this.state.confirm
    if (!card || card.state !== 'open') return
    this.touch()
    this.voice.unlock()
    if (Date.parse(card.expires_at) <= Date.now()) {
      this.set({ confirm: { ...card, state: 'expired' } })
      return
    }
    this.set({ confirm: { ...card, state: 'sending' } })
    this.submit({
      text,
      via: via ?? this.lastVia,
      confirm: { action_id: card.action_id, decision },
      display: text || (decision === 'confirm' ? 'Ja, ausführen' : 'Nein'),
    })
  }

  private submit(job: Job): void {
    if (job.display) this.pushMessage({ role: 'user', text: job.display, via: job.via })
    this.lastVia = job.via
    this.queue.push(job)
    if (!this.busy) void this.drain()
  }

  /** Immer nur eine Runde gleichzeitig - weitere Sätze warten in der Schlange. */
  private async drain(): Promise<void> {
    const gen = ++this.drainGen
    this.busy = true
    this.refreshPhase()
    this.syncWake()
    try {
      while (this.queue.length && gen === this.drainGen) await this.runTurn(this.queue.shift()!)
    } finally {
      if (gen === this.drainGen) {
        this.busy = false
        this.refreshPhase()
        this.persist()
      }
    }
    if (gen === this.drainGen) void this.afterTurns(gen)
  }

  /** Nach der Antwort: bei einer Rückfrage gleich wieder zuhören, sonst auf „Hi Jarvis“ warten. */
  private async afterTurns(gen: number): Promise<void> {
    await this.voice.whenIdle()
    if (gen !== this.drainGen || this.busy || this.listener) return
    const followUp = this.lastExpectsReply && this.lastVia === 'voice' && this.state.open && this.state.mic !== 'none' && !this.draft
    if (!followUp) return this.syncWake(2000)
    setTimeout(() => {
      if (gen === this.drainGen && !this.busy && !this.listener && !this.voice.isSpeaking() && this.state.open) this.listen('followup')
    }, 250)
  }

  private async runTurn(job: Job): Promise<void> {
    const speak = job.via === 'voice' && this.state.settings.speak
    const reply = this.pushMessage({ role: 'assistant', text: '', pending: true })
    const turn: TurnState = {
      id: newId('t'), via: job.via, speak, spoke: false, momentSaid: false, momentTimer: null, tool: null,
      navigated: new Set(), expectsReply: false, replyId: reply.id,
    }
    this.turn = turn
    if (speak) this.voice.begin()
    // Eigene, noch nicht gespeicherte Planänderungen zuerst speichern
    await bus.flushPending()
    const abort = new AbortController()
    this.turnAbort = abort
    const req: JarvisTurnRequest = {
      turn_id: turn.id,
      conversation_id: this.conversationId,
      input: { text: job.text, via: job.via },
      history: this.history,
      confirm: job.confirm,
      context: this.context(),
    }
    try {
      for await (const evt of streamTurn(req, abort.signal)) this.onEvent(evt, turn)
    } catch (e) {
      console.error('[jarvis] Runde fehlgeschlagen', e)
    } finally {
      if (turn.momentTimer) clearTimeout(turn.momentTimer)
      if (this.turnAbort === abort) this.turnAbort = null
      if (this.turn === turn) this.turn = null
    }
    if (abort.signal.aborted) return
    if (turn.speak) this.voice.end()
    this.patchMessage(reply.id, (m) => ({ ...m, pending: false, text: m.text.trim() }))
    const final = this.state.messages.find((m) => m.id === reply.id)
    if (final && !final.text && !final.steps.length && !final.error) this.set({ messages: this.state.messages.filter((m) => m.id !== reply.id) })
    if (job.confirm) {
      // Entschiedene Karte schließen - außer der Server hat inzwischen eine neue gezeigt
      if (this.state.confirm?.action_id === job.confirm.action_id) this.set({ confirm: null })
      // Den wartenden Schritt der ursprünglichen Antwort als entschieden markieren
      const { action_id, decision } = job.confirm
      const failed = !!this.state.messages.find((m) => m.id === reply.id)?.error
      this.set({
        messages: this.state.messages.map((m) =>
          m.steps.some((s) => s.status === 'waiting' && s.action_id === action_id)
            ? {
                ...m,
                steps: m.steps.map((s) =>
                  s.status === 'waiting' && s.action_id === action_id
                    ? { ...s, status: decision === 'confirm' && !failed ? 'ok' : 'cancelled', label: decision === 'confirm' && !failed ? 'Bestätigt' : 'Nicht ausgeführt' }
                    : s,
                ),
              }
            : m,
        ),
      })
    }
    this.lastTurnAt = Date.now()
    this.lastExpectsReply = turn.expectsReply
    this.persist()
  }

  private onEvent(evt: JarvisEvent, turn: TurnState): void {
    switch (evt.type) {
      case 'text_delta':
        this.patchMessage(turn.replyId, (m) => ({ ...m, text: m.text + evt.text }))
        if (turn.speak) {
          this.voice.feed(evt.text)
          turn.spoke = true
        }
        if (turn.momentTimer) clearTimeout(turn.momentTimer)
        turn.momentTimer = null
        break
      case 'tool_start':
        turn.tool = evt.name
        this.patchMessage(turn.replyId, (m) => ({ ...m, steps: [...m.steps, { id: evt.id, label: evt.label, status: 'running' }] }))
        // Werkzeug läuft, aber noch nichts gesagt: nach 1,2 s einmal „Einen Moment.“
        if (turn.speak && !turn.spoke && !turn.momentSaid && !turn.momentTimer) {
          turn.momentTimer = setTimeout(() => {
            turn.momentTimer = null
            if (!turn.speak || turn.spoke || this.turn !== turn) return
            turn.momentSaid = true
            this.voice.say('Einen Moment.')
          }, 1200)
        }
        break
      case 'tool_update':
        this.patchStep(turn.replyId, evt.id, (s) => ({ ...s, label: evt.label }))
        break
      case 'tool_end': {
        const status: JarvisStep['status'] = evt.ok
          ? 'ok'
          : evt.status === 'needs_confirmation'
            ? 'waiting'
            : evt.status === 'ambiguous' || evt.status === 'not_found'
              ? 'question'
              : 'error'
        this.patchStep(turn.replyId, evt.id, (s) => ({ ...s, status, label: evt.summary || s.label, action_id: evt.action_id, undoable: evt.undoable, link: evt.link }))
        turn.tool = null
        break
      }
      case 'ui':
        this.applyUi(evt, turn)
        break
      case 'confirm': {
        const { type: _type, ...card } = evt
        this.set({ confirm: { ...card, state: 'open' }, open: true, minimized: false })
        break
      }
      case 'items':
        this.history = trimHistory([...this.history, ...evt.items])
        break
      case 'done':
        turn.expectsReply = evt.expects_reply
        break
      case 'error': {
        this.patchMessage(turn.replyId, (m) => ({ ...m, error: true, text: m.text.trim() ? `${m.text.trim()} ${evt.message}` : evt.message }))
        if (turn.speak) this.voice.say(evt.message)
        this.set({ minimized: false })
        // Unklarer Stand (Konflikt, Abbruch): den geöffneten Plan sicherheitshalber neu laden
        const projectId = this.context().project_id
        if (projectId && (evt.code === 'conflict' || evt.code === 'internal')) bus.emit('reload-project', { projectId, version: Number.MAX_SAFE_INTEGER })
        break
      }
    }
  }

  // ------------------------------------------------------------ Sichtbare Folgen

  private applyUi(evt: JarvisUiEvent, turn: TurnState | null): void {
    switch (evt.action) {
      case 'reload_project':
        bus.emit('reload-project', { projectId: evt.project_id, version: evt.version })
        break
      case 'data_changed':
        bus.emit('data-changed', { scope: evt.scope })
        break
      case 'highlight':
        bus.emit('highlight', { projectId: evt.project_id, taskIds: evt.task_ids })
        break
      case 'focus_task': {
        const to = `/projects/${evt.project_id}/gantt?${evt.open_drawer ? 'task' : 'focus'}=${encodeURIComponent(evt.task_id)}`
        if (location.pathname === `/projects/${evt.project_id}/gantt`) {
          bus.emit('focus-task', { projectId: evt.project_id, taskId: evt.task_id, openDrawer: evt.open_drawer })
          this.showing(turn)
        } else if (this.mayNavigate(turn, evt.project_id)) {
          navigate(to)
          this.showing(turn)
        } else this.offerLink(turn, { label: 'Im Plan ansehen', to })
        break
      }
      case 'navigate': {
        if (!ALLOWED_PATHS.some((re) => re.test(evt.to)) || location.pathname + location.search === evt.to) break
        const key = /^\/projects\/([\w-]+)/.exec(evt.to)?.[1] ?? evt.to
        if (this.mayNavigate(turn, key)) {
          navigate(evt.to)
          this.showing(turn)
        } else this.offerLink(turn, { label: 'Ansehen', to: evt.to })
        break
      }
    }
  }

  /** Darf Jarvis die Ansicht jetzt wechseln? Sonst bekommt der Nutzer einen Link. */
  private mayNavigate(turn: TurnState | null, key: string): boolean {
    if (turn?.navigated.has(key)) return false
    const explicit = !!turn?.tool && EXPLICIT_NAV_TOOLS.has(turn.tool)
    if (!explicit) {
      if (!this.state.settings.autoFollow) return false
      // Auf dem Handy und auf der Baustellenansicht nicht ungefragt wegspringen
      if (window.innerWidth < 1024 || location.pathname.startsWith('/site')) return false
      // Nicht mitten in einer Eingabe oder einem offenen Dialog
      if (document.querySelector('[role="dialog"]')) return false
      const active = document.activeElement as HTMLElement | null
      if (active?.matches('input, textarea, select, [contenteditable="true"]') && !active.closest('[data-jarvis]')) return false
    }
    turn?.navigated.add(key)
    return true
  }

  /**
   * Jarvis zeigt etwas im Plan: Panel einklappen, damit es nicht verdeckt wird - bei Sprache immer,
   * sonst wenn der Bildschirm zu klein für Plan und Panel nebeneinander ist.
   */
  private showing(turn: TurnState | null): void {
    if (!turn || this.state.confirm?.state === 'open') return
    if (turn.via === 'voice' || window.innerWidth < 768 || window.innerHeight < 1000) this.set({ minimized: true })
  }

  private offerLink(turn: TurnState | null, link: { label: string; to: string }): void {
    if (turn) this.patchMessage(turn.replyId, (m) => ({ ...m, link }))
  }

  /** „Rückgängig“ an einem Schritt - ohne KI, direkt über den Server. */
  async undo(messageId: string, stepId: string): Promise<void> {
    const step = this.state.messages.find((m) => m.id === messageId)?.steps.find((s) => s.id === stepId)
    if (!step?.action_id || step.undo) return
    this.touch()
    this.patchStep(messageId, stepId, (s) => ({ ...s, undo: 'running' }))
    await bus.flushPending()
    try {
      const res = await fetch(`${API_BASE}/api/jarvis/actions/${encodeURIComponent(step.action_id)}/undo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ path: location.pathname }),
      })
      const json = (await res.json().catch(() => null)) as { ok?: boolean; summary?: string; message?: string; error?: string; events?: JarvisEvent[] } | null
      if (res.ok && json?.ok) {
        this.patchStep(messageId, stepId, (s) => ({ ...s, undo: 'done' }))
        const pseudo: TurnState = {
          id: 'undo', via: 'text', speak: false, spoke: false, momentSaid: false, momentTimer: null, tool: 'undo',
          navigated: new Set(), expectsReply: false, replyId: messageId,
        }
        for (const e of json.events ?? []) if (e.type === 'ui') this.applyUi(e, pseudo)
        this.history = trimHistory([...this.history, { role: 'assistant', content: `(Über die Schaltfläche rückgängig gemacht: ${json.summary ?? step.label})` }])
        this.persist()
      } else {
        this.patchStep(messageId, stepId, (s) => ({ ...s, undo: undefined, undoable: false }))
        this.set({ notice: { tone: 'error', text: json?.message ?? json?.error ?? 'Das lässt sich nicht mehr rückgängig machen.' }, open: true, minimized: false })
      }
    } catch {
      this.patchStep(messageId, stepId, (s) => ({ ...s, undo: undefined }))
      this.set({ notice: { tone: 'error', text: 'Keine Verbindung zum Server.' } })
    }
  }

  // ------------------------------------------------------------ Zuhören

  private listen(mode: 'command' | 'followup'): void {
    if (this.listener || !this.state.ready) return
    if (this.state.mic === 'none') {
      this.set({ focusInput: this.state.focusInput + 1 })
      return
    }
    // Es darf immer nur eine Erkennung laufen: „Hi Jarvis“ erst sauber beenden
    const wakeWasActive = this.wakeListener.isActive()
    this.wakeListener.stop()
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    this.voice.stop()
    const listener: Listener = this.state.mic === 'native' ? new CommandListener() : new RecorderListener()
    this.listener = listener
    let delivered = false
    this.set({ interim: '', notice: null })
    this.refreshPhase()
    const begin = () => {
      if (this.listener !== listener) return
      this.voice.tone('up')
      listener.start(
        {
          onInterim: (text) => {
            if (this.listener === listener) this.set({ interim: text })
          },
          onFinal: (text) => {
            if (this.listener !== listener) return
            delivered = true
            this.listener = null
            this.set({ interim: '' })
            this.handleInput(text, 'voice')
          },
          onEnd: () => {
            const mine = this.listener === listener
            if (mine) {
              this.listener = null
              this.set({ interim: '' })
            }
            if (!delivered && (mine || !this.listener)) this.voice.tone('down')
            this.refreshPhase()
            this.syncWake(800)
          },
          onError: (code) => this.micError(code, listener, mode),
        },
        { silenceMs: mode === 'followup' ? 8000 : 6000, maxMs: 30_000 },
      )
    }
    if (wakeWasActive) setTimeout(begin, 300)
    else begin()
  }

  private cancelListening(): void {
    const l = this.listener
    if (!l) return
    this.listener = null
    l.abort()
    this.set({ interim: '' })
  }

  private micError(code: string, listener: Listener, mode: 'command' | 'followup'): void {
    if (this.listener === listener) this.listener = null
    this.set({ interim: '' })
    // Browser ohne funktionierende eingebaute Erkennung (Brave, Opera …): Aufnahme + Server
    const fallback = ['network', 'service-not-allowed', 'language-not-supported', 'unsupported', 'start-failed'].includes(code)
    if (fallback && this.state.mic === 'native' && hasRecorder() && this.state.server?.stt) {
      this.forceRecorder = true
      this.set({ mic: 'recorder' })
      this.listen(mode)
      return
    }
    let text: string
    let tone: 'info' | 'error' = 'error'
    if (code === 'not-allowed' && mode === 'followup') {
      text = 'Tippe auf das Mikrofon, um zu antworten.'
      tone = 'info'
    } else if (code === 'not-allowed') text = 'Das Mikrofon ist blockiert. Erlaube es über das Schloss-Symbol in der Adresszeile – oder schreib mir einfach.'
    else if (code === 'audio-capture') text = 'Kein Mikrofon gefunden. Du kannst mir auch schreiben.'
    else if (code === 'network') text = 'Die Spracherkennung braucht eine Internetverbindung. Versuch es gleich noch einmal oder schreib mir.'
    else if (code === 'stt-unavailable' || fallback) text = 'Die Spracherkennung ist gerade nicht verfügbar – schreib mir einfach.'
    else text = 'Ich konnte dich nicht verstehen. Versuch es noch einmal oder schreib mir.'
    // Dauerhaft nicht verfügbar (nicht bloß kurz offline): Mikrofon-Knopf ausblenden
    if (code === 'stt-unavailable' || (fallback && code !== 'network')) this.set({ mic: 'none' })
    this.set({ notice: { tone, text }, focusInput: this.state.focusInput + 1 })
    this.refreshPhase()
  }

  // ------------------------------------------------------------ Hilfen

  private context(): JarvisContext {
    const path = location.pathname
    const match = /^\/projects\/([\w-]+)/.exec(path)
    const projectId = match && match[1] !== 'new' ? match[1]! : null
    const bc = bus.getContext()
    return {
      today: localToday(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin',
      path,
      project_id: projectId,
      task_id: projectId && bc.projectId === projectId ? bc.taskId : null,
      view: window.innerWidth < 768 ? 'mobile' : 'desktop',
    }
  }

  private pushMessage(m: Omit<JarvisMessage, 'id' | 'steps'>): JarvisMessage {
    const msg: JarvisMessage = { id: newId('m'), steps: [], ...m }
    this.set({ messages: [...this.state.messages, msg].slice(-MAX_MESSAGES) })
    return msg
  }

  private patchMessage(id: string, fn: (m: JarvisMessage) => JarvisMessage): void {
    this.set({ messages: this.state.messages.map((m) => (m.id === id ? fn(m) : m)) })
  }

  private patchStep(messageId: string, stepId: string, fn: (s: JarvisStep) => JarvisStep): void {
    this.patchMessage(messageId, (m) => ({ ...m, steps: m.steps.map((s) => (s.id === stepId ? fn(s) : s)) }))
  }

  /** Gespräch im Tab behalten (Neuladen der Seite), nicht aber über Tabs oder Nutzer hinweg. */
  private persist(): void {
    if (!this.user) return
    try {
      const confirm = this.state.confirm?.state === 'open' ? this.state.confirm : null
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ v: 1, userId: this.user.id, orgId: this.user.orgId, conversationId: this.conversationId, history: this.history, messages: this.state.messages, confirm, lastTurnAt: this.lastTurnAt }),
      )
    } catch {
      /* Speicher voll oder gesperrt */
    }
  }

  private restore(): void {
    if (!this.user) return
    try {
      const raw = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as {
        v: number; userId: string; orgId: string; conversationId: string; history: JarvisItem[]; messages: JarvisMessage[]; confirm: JarvisConfirmState | null; lastTurnAt: number
      } | null
      if (!raw || raw.v !== 1 || raw.userId !== this.user.id || raw.orgId !== this.user.orgId) return
      if (!raw.lastTurnAt || Date.now() - raw.lastTurnAt > CONVERSATION_IDLE_MS) return
      this.conversationId = raw.conversationId
      this.history = trimHistory(raw.history ?? [])
      this.lastTurnAt = raw.lastTurnAt
      const messages = (raw.messages ?? []).map((m) => ({
        ...m,
        pending: false,
        steps: (m.steps ?? []).map((s) => (s.status === 'running' ? { ...s, status: 'error' as const } : s.undo === 'running' ? { ...s, undo: undefined } : s)),
      }))
      const confirm = raw.confirm && Date.parse(raw.confirm.expires_at) > Date.now() ? { ...raw.confirm, state: 'open' as const } : null
      // Wartende Schritte ohne offene Karte sind abgelaufen
      for (const m of messages) {
        m.steps = m.steps.map((s) => (s.status === 'waiting' && s.action_id !== confirm?.action_id ? { ...s, status: 'cancelled' as const, label: 'Abgelaufen' } : s))
      }
      this.state = { ...this.state, messages, confirm }
    } catch {
      /* beschädigt - neues Gespräch */
    }
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}

function trimHistory(items: JarvisItem[]): JarvisItem[] {
  let out = items.slice(-MAX_HISTORY_ITEMS)
  let size = out.reduce((n, it) => n + JSON.stringify(it).length, 0)
  while (out.length > 1 && size > MAX_HISTORY_CHARS) {
    size -= JSON.stringify(out[0]).length
    out = out.slice(1)
  }
  return out
}

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

const g = globalThis as unknown as { __bautaktJarvis?: JarvisEngine }
export const jarvis: JarvisEngine = g.__bautaktJarvis ?? (g.__bautaktJarvis = new JarvisEngine())

export function useJarvis(): JarvisState {
  return useSyncExternalStore(jarvis.subscribe, jarvis.getState, jarvis.getState)
}

if (import.meta.env?.DEV && typeof window !== 'undefined') {
  // Zum Testen ohne Mikrofon: __jarvis.say('…') verhält sich wie ein gesprochener Satz
  ;(window as unknown as { __jarvis?: unknown }).__jarvis = {
    say: (text: string) => jarvis.handleInput(text, 'voice'),
    type: (text: string) => jarvis.handleInput(text, 'text'),
    wake: (rest = '') => jarvis.simulateWake(rest),
    state: () => jarvis.getState(),
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    jarvis.dispose()
    delete g.__bautaktJarvis
  })
}
