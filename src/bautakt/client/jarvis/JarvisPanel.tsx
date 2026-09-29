/**
 * Oberfläche von Jarvis: runder Knopf unten links, Gesprächsfenster mit Schritten
 * (inkl. „Rückgängig“), Bestätigungskarte und Eingabe. Eingeklappt: eine Zeile mit dem,
 * was Jarvis gerade sagt - damit der Plan sichtbar bleibt.
 */

import clsx from 'clsx'
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  AlertTriangle, ArrowUpRight, AudioLines, ChevronUp, CircleCheck, CircleHelp, CircleSlash, CircleX, Clock, Loader2, Mic, Minus, MoveDiagonal2, RotateCcw, Send, Settings, Sparkles, Square, Undo2, Volume2, X,
} from 'lucide-react'
import { navigate } from '../lib/router'
import { Button, IconButton } from '../components/ui'
import { GREETING, jarvis, type JarvisConfirmState, type JarvisMessage, type JarvisPhase, type JarvisState, type JarvisStep } from './engine'
import { loadLayout, saveLayout, type JarvisLayout } from './layout'

const EXAMPLES = [
  'Was steht diese Woche an?',
  'Wie ist der Stand im Projekt?',
  'Verschieb den Estrich um zwei Tage.',
  'Gib Max die Aufgabe „Gerüst prüfen“ bis Freitag.',
]

const HINT_KEY = 'bautakt.jarvis.hint'

/** Gerät mit Tastatur/Maus? Sonst (Handy, Tablet) keine Hinweise auf Alt+J. */
const hasKeyboard = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches

const PHASE_TEXT: Record<JarvisPhase, string> = {
  idle: 'Bereit',
  listening: 'Hört zu …',
  thinking: 'Denkt nach …',
  speaking: 'Spricht …',
}

// Fenstergröße: nur am Computer verschieb-/verkleinerbar (auf dem Handy stört das nur)
const MIN_PANEL_W = 320
const MIN_PANEL_H = 320
const MAX_PANEL_W = 720
const MAX_PANEL_H = 820
const EDGE_MARGIN = 8

function clampLayout(l: JarvisLayout): JarvisLayout {
  // Erst auf die gewünschte Spanne begrenzen, DANACH hart auf den Sichtbereich kappen - sonst würde
  // ein sehr kleines Browserfenster die Mindestgröße erzwingen und das Fenster nach oben hinausschieben.
  const maxW = Math.max(160, window.innerWidth - EDGE_MARGIN * 2)
  const maxH = Math.max(160, window.innerHeight - EDGE_MARGIN * 2)
  const width = Math.min(maxW, Math.min(MAX_PANEL_W, Math.max(MIN_PANEL_W, l.width)))
  const height = Math.min(maxH, Math.min(MAX_PANEL_H, Math.max(MIN_PANEL_H, l.height)))
  const left = Math.min(Math.max(EDGE_MARGIN, l.left), Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN))
  const top = Math.min(Math.max(EDGE_MARGIN, l.top), Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN))
  return { left, top, width, height }
}

export function JarvisUi({ state, noSidebar }: { state: JarvisState; noSidebar: boolean }) {
  const [hint, setHint] = useState(() => {
    try {
      return !localStorage.getItem(HINT_KEY)
    } catch {
      return false
    }
  })
  const hideHint = () => {
    setHint(false)
    try {
      localStorage.setItem(HINT_KEY, '1')
    } catch {
      /* privater Modus */
    }
  }

  const left = noSidebar ? 'left-4' : 'left-4 lg:left-[calc(15rem+1.5rem)]'
  const bottom = noSidebar ? 'bottom-4' : 'bottom-4 lg:bottom-6'

  return (
    <div data-jarvis className="no-print">
      {state.open && !state.minimized && <Panel state={state} noSidebar={noSidebar} />}
      {state.open && state.minimized && <Pill state={state} noSidebar={noSidebar} />}
      {hint && !state.open && (
        <div className={clsx('animate-fade-in fixed z-[45] w-64 rounded-xl border border-line bg-surface p-3 text-xs text-ink-soft shadow-xl', left, noSidebar ? 'bottom-[5.25rem]' : 'bottom-[5.25rem] lg:bottom-[5.75rem]')}>
          <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Sparkles size={14} className="text-brand" /> Neu: Jarvis
          </div>
          {hasKeyboard() ? (
            <>
              Klick auf den Knopf oder drück <b>Alt+J</b> und sag einfach, was du brauchst
            </>
          ) : (
            'Tipp auf den Knopf und sag einfach, was du brauchst'
          )}{' '}
          – z. B. „Verschieb den Estrich um zwei Tage“.
          <button type="button" className="mt-2 block text-brand hover:underline" onClick={hideHint}>
            Verstanden
          </button>
        </div>
      )}
      <Orb
        state={state}
        className={clsx('fixed z-[45]', left, bottom)}
        onClick={() => {
          hideHint()
          jarvis.activate()
        }}
      />
    </div>
  )
}

function Orb({ state, className, onClick }: { state: JarvisState; className: string; onClick: () => void }) {
  const { phase, wake } = state
  const title =
    phase === 'listening' ? 'Jarvis hört zu – klicken zum Beenden' : phase === 'speaking' ? 'Jarvis unterbrechen und sprechen' : hasKeyboard() ? 'Jarvis – klicken oder Alt+J, dann sprechen' : 'Jarvis – antippen, dann sprechen'
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={clsx('jarvis-orb flex h-14 w-14 items-center justify-center rounded-full text-white transition hover:scale-105 focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/30', className)}
    >
      {phase === 'listening' && <span className="jarvis-ring" aria-hidden />}
      {phase === 'thinking' && <span className="jarvis-spinner" aria-hidden />}
      {phase === 'listening' ? <AudioLines size={24} /> : phase === 'speaking' ? <Bars /> : <Mic size={24} />}
      {wake !== 'off' && (
        <span
          className={clsx('absolute top-0.5 right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white', wake === 'on' ? 'bg-ok' : 'bg-muted')}
          title={wake === 'on' ? `Hört auf „${jarvis.wakePhrase()}“` : `„${jarvis.wakePhrase()}“ pausiert – klick irgendwo, um es fortzusetzen`}
        />
      )}
    </button>
  )
}

function Bars() {
  return (
    <span className="jarvis-bars" aria-hidden>
      <span />
      <span />
      <span />
      <span />
    </span>
  )
}

function Pill({ state, noSidebar }: { state: JarvisState; noSidebar: boolean }) {
  const last = [...state.messages].reverse().find((m) => m.role === 'assistant')
  let text = state.phase === 'listening' ? state.interim || 'Ich höre zu …' : last?.text || PHASE_TEXT[state.phase]
  if (text.length > 110) text = `… ${text.slice(-110)}`
  return (
    <button
      type="button"
      onClick={() => jarvis.setMinimized(false)}
      title="Jarvis aufklappen"
      className={clsx(
        'animate-fade-in fixed z-[45] flex max-w-[min(460px,calc(100vw-6.5rem))] items-center gap-2 rounded-full border border-line bg-surface/95 py-2 pr-3 pl-3.5 text-left text-sm text-ink shadow-lg backdrop-blur',
        noSidebar ? 'bottom-[1.6rem] left-[5rem]' : 'bottom-[1.6rem] left-[5rem] lg:bottom-[2.1rem] lg:left-[calc(15rem+6rem)]',
      )}
    >
      <PhaseDot phase={state.phase} />
      <span className="min-w-0 truncate">{text}</span>
      <ChevronUp size={15} className="shrink-0 text-ink-faint" />
    </button>
  )
}

function PhaseDot({ phase }: { phase: JarvisPhase }) {
  if (phase === 'thinking') return <Loader2 size={14} className="shrink-0 animate-spin text-brand" />
  if (phase === 'speaking') return <Volume2 size={14} className="shrink-0 text-brand" />
  if (phase === 'listening') return <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-danger" />
  return <Sparkles size={14} className="shrink-0 text-brand" />
}

function Panel({ state, noSidebar }: { state: JarvisState; noSidebar: boolean }) {
  const { phase, messages, confirm, notice, server, mic } = state
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const [draft, setDraft] = useState('')
  // Verschieb-/verkleinerbar, sobald für die Desktop-Breite gerendert wird (ab hier zeigt das Panel
  // die feste Größe statt der handy-breiten Ansicht). Bewusst an der Fensterbreite festgemacht, nicht
  // an „pointer: fine“ - Touchscreen-Laptops melden dort browserabhängig manchmal „coarse“, obwohl
  // Maus/Trackpad vorhanden sind.
  const [draggable, setDraggable] = useState(() => window.innerWidth >= 640)
  useEffect(() => {
    const onResize = () => setDraggable(window.innerWidth >= 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const [layout, setLayout] = useState<JarvisLayout | null>(null)
  useEffect(() => {
    if (draggable) setLayout(loadLayout(state.userId))
  }, [draggable, state.userId])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, confirm])

  useEffect(() => {
    if (state.focusInput) inputRef.current?.focus()
  }, [state.focusInput])

  useEffect(() => {
    jarvis.setDraft(draft.trim().length > 0)
  }, [draft])

  // Beim Verkleinern des Browserfensters im Sichtbereich halten
  useEffect(() => {
    if (!draggable) return
    const onResize = () =>
      setLayout((l) => {
        if (!l) return l
        const c = clampLayout(l)
        if (c.left === l.left && c.top === l.top && c.width === l.width && c.height === l.height) return l
        saveLayout(state.userId, c)
        return c
      })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draggable, state.userId])

  /** Kopfzeile ziehen = verschieben, Rand/Ecke ziehen = Breite/Höhe/beides ändern; danach je Nutzer gespeichert. */
  const startDrag = (mode: 'move' | 'resize-x' | 'resize-y' | 'resize-xy', e: ReactPointerEvent) => {
    if (!draggable || e.button !== 0) return
    const el = sectionRef.current
    if (!el) return
    e.preventDefault()
    e.stopPropagation()
    const rect = el.getBoundingClientRect()
    const start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      const next = { left: start.left, top: start.top, width: start.width, height: start.height }
      if (mode === 'move') {
        next.left += dx
        next.top += dy
      } else {
        if (mode === 'resize-x' || mode === 'resize-xy') next.width += dx
        if (mode === 'resize-y' || mode === 'resize-xy') next.height += dy
      }
      setLayout(clampLayout(next))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setLayout((l) => {
        if (l) saveLayout(state.userId, l)
        return l
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    jarvis.sendText(text)
    setDraft('')
  }

  const status =
    phase !== 'idle'
      ? PHASE_TEXT[phase]
      : state.wake === 'on'
        ? `Sag „${jarvis.wakePhrase()}“ oder drück Alt+J`
        : mic === 'none'
          ? 'Schreib mir, was du brauchst'
          : hasKeyboard()
            ? 'Alt+J oder Mikrofon zum Sprechen'
            : 'Mikrofon antippen und sprechen'

  return (
    <section
      ref={sectionRef}
      role="region"
      aria-label="Jarvis"
      data-jarvis-panel
      style={layout ? { left: layout.left, top: layout.top, width: layout.width, height: layout.height, right: 'auto', bottom: 'auto' } : undefined}
      className={clsx(
        'animate-fade-in fixed z-[45] flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl',
        layout ? 'max-h-none' : clsx('max-h-[min(640px,calc(100dvh-7.5rem))] right-2 bottom-[5.25rem] left-2 sm:right-auto sm:left-4 sm:w-[400px]', !noSidebar && 'lg:bottom-[6rem] lg:left-[calc(15rem+1.5rem)]'),
      )}
    >
      <header
        className={clsx('flex items-center gap-2 border-b border-line py-2 pr-1.5 pl-3', draggable && 'cursor-move select-none')}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          startDrag('move', e)
        }}
        title={draggable ? 'Ziehen zum Verschieben' : undefined}
      >
        <span className="jarvis-orb flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-sm font-semibold text-ink">Jarvis</div>
          <div className="truncate text-[11px] text-ink-faint">{status}</div>
        </div>
        {(phase === 'speaking' || phase === 'listening') && (
          <IconButton title="Stopp (Esc)" onClick={() => jarvis.stopAll()}>
            <Square size={14} />
          </IconButton>
        )}
        <IconButton title="Neues Gespräch" onClick={() => jarvis.newConversation()} disabled={phase === 'thinking' || !messages.length}>
          <RotateCcw size={15} />
        </IconButton>
        <IconButton title="Jarvis-Einstellungen" onClick={() => navigate('/settings#jarvis')}>
          <Settings size={15} />
        </IconButton>
        <IconButton title="Einklappen" onClick={() => jarvis.setMinimized(true)}>
          <Minus size={15} />
        </IconButton>
        <IconButton title="Schließen (Esc)" onClick={() => jarvis.close()}>
          <X size={15} />
        </IconButton>
      </header>

      {server && !server.ai && (
        <div className="border-b border-line bg-warn-soft px-3 py-2 text-xs text-ink-soft">Die KI ist auf diesem Server noch nicht eingerichtet – Jarvis kann gerade nicht antworten.</div>
      )}
      {notice && (
        <div className={clsx('flex items-start gap-2 border-b border-line px-3 py-2 text-xs', notice.tone === 'error' ? 'bg-danger-soft text-danger' : 'bg-brand-soft text-brand-strong')}>
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button type="button" className="shrink-0 opacity-70 hover:opacity-100" onClick={() => jarvis.dismissNotice()} aria-label="Hinweis schließen">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Bestätigungskarte gehört mit in den scrollbaren Bereich - sonst könnte sie bei wenig
         Platz die Fußleiste (Eingabefeld) aus dem sichtbaren Bereich drücken. */}
      <div ref={scrollRef} className="min-h-[120px] flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? <Welcome /> : messages.map((m) => <MessageView key={m.id} m={m} />)}
        {confirm && <ConfirmCard card={confirm} />}
      </div>

      <footer className="shrink-0 border-t border-line p-2">
        {phase === 'listening' && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-brand-soft px-3 py-2 text-sm text-brand-strong">
            <Bars />
            <span className="min-w-0 flex-1 truncate">{state.interim || 'Ich höre zu …'}</span>
            <button type="button" className="shrink-0 text-xs font-medium hover:underline" onClick={() => jarvis.toggleListening()}>
              Fertig
            </button>
          </div>
        )}
        <form onSubmit={submit} className="flex items-center gap-1">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={mic === 'none' ? 'Schreib Jarvis, was du brauchst …' : 'Schreiben – oder Mikrofon drücken …'}
            aria-label="Nachricht an Jarvis"
            enterKeyHint="send"
            className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 text-base text-ink outline-none placeholder:text-ink-faint focus:border-brand focus:bg-surface focus:ring-2 focus:ring-brand/20 sm:text-sm"
          />
          {mic !== 'none' && (
            <IconButton
              title={phase === 'listening' ? 'Zuhören beenden' : 'Sprechen'}
              onClick={() => jarvis.toggleListening()}
              className={clsx('h-10 w-10', phase === 'listening' && 'bg-danger-soft text-danger hover:bg-danger-soft hover:text-danger')}
            >
              {phase === 'listening' ? <Square size={16} /> : <Mic size={18} />}
            </IconButton>
          )}
          <IconButton type="submit" title="Senden" disabled={!draft.trim()} className="h-10 w-10 text-brand">
            <Send size={17} />
          </IconButton>
        </form>
      </footer>
      {draggable && (
        <>
          {/* Breite/Höhe über die Ränder - großzügige, leicht zu treffende Ziehzonen */}
          <div onPointerDown={(e) => startDrag('resize-x', e)} title="Breite ändern" className="absolute top-2 right-0 bottom-6 z-10 w-2.5 cursor-ew-resize hover:bg-brand/25" />
          <div onPointerDown={(e) => startDrag('resize-y', e)} title="Höhe ändern" className="absolute right-6 bottom-0 left-2 z-10 h-2.5 cursor-ns-resize hover:bg-brand/25" />
          {/* Ecke etwas eingerückt, damit sie nicht von der abgerundeten Fensterecke abgeschnitten wird */}
          <div
            onPointerDown={(e) => startDrag('resize-xy', e)}
            title="Größe ändern"
            className="absolute right-1 bottom-1 z-20 flex h-6 w-6 cursor-nwse-resize items-center justify-center rounded-md text-ink-faint hover:bg-brand/25 hover:text-brand"
          >
            <MoveDiagonal2 size={13} />
          </div>
        </>
      )}
    </section>
  )
}

function Welcome() {
  return (
    <div className="py-1 text-center">
      <div className="text-sm font-medium text-ink">{GREETING}</div>
      <div className="mt-1 text-xs text-ink-faint">Sag oder schreib einfach, was du brauchst. Zum Beispiel:</div>
      <div className="mt-3 flex flex-col gap-1.5">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => jarvis.sendText(ex)}
            className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-left text-xs text-ink-soft transition hover:border-brand/50 hover:text-ink"
          >
            „{ex}“
          </button>
        ))}
      </div>
    </div>
  )
}

function MessageView({ m }: { m: JarvisMessage }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-3 py-2 text-sm whitespace-pre-wrap text-white">
          {m.via === 'voice' && <Mic size={11} className="mr-1 -mt-0.5 inline opacity-70" />}
          {m.text}
        </div>
      </div>
    )
  }
  return (
    <div className="flex gap-2">
      <span className="jarvis-orb mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white">
        <Sparkles size={12} />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        {(m.text || (m.pending && !m.steps.length)) && (
          <div className={clsx('inline-block max-w-full rounded-2xl rounded-tl-md px-3 py-2 text-sm whitespace-pre-wrap', m.error ? 'bg-danger-soft text-danger' : 'bg-surface-3 text-ink')}>
            {m.text || <Typing />}
          </div>
        )}
        {m.steps.length > 0 && (
          <ul className="space-y-1">
            {m.steps.map((s) => (
              <li key={s.id} className="flex min-h-6 items-center gap-1.5 text-xs text-ink-soft">
                <StepIcon status={s.status} />
                <span className={clsx('min-w-0 flex-1 truncate', s.undo === 'done' && 'line-through opacity-60')} title={s.label}>
                  {s.label}
                </span>
                {s.undoable && s.action_id && s.undo !== 'done' && (
                  <Chip onClick={() => void jarvis.undo(m.id, s.id)} disabled={s.undo === 'running'}>
                    {s.undo === 'running' ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />} Rückgängig
                  </Chip>
                )}
                {s.undo === 'done' && <span className="shrink-0 text-[11px] text-ink-faint">rückgängig gemacht</span>}
                {s.link && (
                  <Chip onClick={() => navigate(s.link!.to)}>
                    {s.link.label} <ArrowUpRight size={11} />
                  </Chip>
                )}
              </li>
            ))}
          </ul>
        )}
        {m.pending && m.steps.length > 0 && !m.text && <Typing />}
        {m.link && (
          <Chip onClick={() => navigate(m.link!.to)}>
            {m.link.label} <ArrowUpRight size={11} />
          </Chip>
        )}
      </div>
    </div>
  )
}

function StepIcon({ status }: { status: JarvisStep['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 size={13} className="shrink-0 animate-spin text-brand" />
    case 'ok':
      return <CircleCheck size={13} className="shrink-0 text-ok" />
    case 'waiting':
      return <Clock size={13} className="shrink-0 text-warn" />
    case 'question':
      return <CircleHelp size={13} className="shrink-0 text-ink-faint" />
    case 'cancelled':
      return <CircleSlash size={13} className="shrink-0 text-ink-faint" />
    default:
      return <CircleX size={13} className="shrink-0 text-danger" />
  }
}

function Chip({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-soft transition hover:border-brand/50 hover:text-brand disabled:opacity-60"
    >
      {children}
    </button>
  )
}

function Typing() {
  return (
    <span className="jarvis-typing inline-flex items-center gap-1 py-1" aria-label="Jarvis schreibt">
      <span />
      <span />
      <span />
    </span>
  )
}

function ConfirmCard({ card }: { card: JarvisConfirmState }) {
  const expired = card.state === 'expired' || Date.parse(card.expires_at) <= Date.now()
  const impact = card.impact
  const shifted = !!impact && impact.old_end !== impact.new_end
  return (
    <div className="rounded-xl border border-warn/30 bg-warn-soft/60 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">{card.title}</div>
          {card.lines.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">
              {card.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          {impact && (
            <div className="mt-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink-soft">Projektende</span>
                <span className={clsx('font-medium tabular-nums', shifted ? 'text-danger' : 'text-ink')}>
                  {shifted ? `${dayLabel(impact.old_end)} → ${dayLabel(impact.new_end)}` : `${dayLabel(impact.new_end)} (bleibt)`}
                </span>
              </div>
              {impact.affected.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 border-t border-line pt-1.5">
                  {impact.affected.slice(0, 5).map((r, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="min-w-0 truncate text-ink">{r.name}</span>
                      <span className="shrink-0 text-ink-soft tabular-nums">
                        {dayLabel(r.old_start)} → {dayLabel(r.new_start)}
                      </span>
                    </li>
                  ))}
                  {impact.affected.length > 5 && <li className="text-ink-faint">und {impact.affected.length - 5} weitere</li>}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex items-center justify-end gap-2">
        {expired ? (
          <span className="text-xs text-ink-faint">Abgelaufen – sag es mir bitte noch einmal.</span>
        ) : (
          <>
            <Button size="sm" onClick={() => jarvis.decide('cancel')} disabled={card.state === 'sending'}>
              Nein
            </Button>
            <Button size="sm" variant="primary" onClick={() => jarvis.decide('confirm')} loading={card.state === 'sending'}>
              Ja, ausführen
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

/** „2026-10-12“ → „Mo 12.10.“ */
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`
}
