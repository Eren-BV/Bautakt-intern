/**
 * Verbindung zwischen Jarvis und der restlichen Oberfläche, ohne dass Jarvis im React-Baum des
 * Projekts hängen muss: Jarvis meldet „Vorgang zeigen / hervorheben / neu laden“, der Gantt und
 * der Projekt-Store melden zurück, was gerade geöffnet bzw. ausgewählt ist.
 */

export interface BusEvents {
  'focus-task': { projectId: string; taskId: string; openDrawer: boolean }
  highlight: { projectId: string; taskIds: string[] }
  'reload-project': { projectId: string; version: number }
  'data-changed': { scope: 'site' | 'projects' | 'notifications' }
}

type Listener<K extends keyof BusEvents> = (payload: BusEvents[K]) => void

interface BusState {
  listeners: Map<keyof BusEvents, Set<Listener<keyof BusEvents>>>
  flush: (() => Promise<void>) | null
  context: { projectId: string | null; taskId: string | null }
  /** Letztes Fokus-/Hervorhebungs-Signal - falls der Terminplan erst noch geladen wird */
  recent: { [K in 'focus-task' | 'highlight']?: { payload: BusEvents[K]; at: number } }
}

// Auf globalThis, damit Hot-Reload und das Neuaufbauen des App-Baums den Zustand nicht verlieren
const g = globalThis as unknown as { __bautaktJarvisBus?: BusState }
const state: BusState = g.__bautaktJarvisBus ?? (g.__bautaktJarvisBus = { listeners: new Map(), flush: null, context: { projectId: null, taskId: null }, recent: {} })
state.recent ??= {}

export function on<K extends keyof BusEvents>(event: K, fn: Listener<K>): () => void {
  const set = state.listeners.get(event) ?? new Set()
  set.add(fn as Listener<keyof BusEvents>)
  state.listeners.set(event, set)
  return () => set.delete(fn as Listener<keyof BusEvents>)
}

export function emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
  if (event === 'focus-task' || event === 'highlight') (state.recent as Record<string, { payload: unknown; at: number }>)[event] = { payload, at: Date.now() }
  for (const fn of state.listeners.get(event) ?? []) {
    try {
      ;(fn as Listener<K>)(payload)
    } catch (e) {
      console.error(`[jarvis] Fehler im Empfänger von ${event}`, e)
    }
  }
}

/** Beim Öffnen des Terminplans: ein gerade erst gesendetes Signal für dieses Projekt abholen. */
export function takeRecent<K extends 'focus-task' | 'highlight'>(event: K, projectId: string, maxAgeMs = 10_000): BusEvents[K] | null {
  const hit = state.recent[event] as { payload: BusEvents[K]; at: number } | undefined
  if (!hit || hit.payload.projectId !== projectId || Date.now() - hit.at > maxAgeMs) return null
  delete state.recent[event]
  return hit.payload
}

/** Der Projekt-Store registriert, wie ausstehende Planänderungen sofort gespeichert werden. */
export function registerFlush(fn: () => Promise<void>): () => void {
  state.flush = fn
  return () => {
    if (state.flush === fn) state.flush = null
  }
}

/** Vor jeder Jarvis-Runde: eigene, noch nicht gespeicherte Änderungen zuerst speichern. */
export async function flushPending(timeoutMs = 2500): Promise<void> {
  const fn = state.flush
  if (!fn) return
  await Promise.race([fn().catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs))])
}

export function setContext(patch: Partial<BusState['context']>): void {
  state.context = { ...state.context, ...patch }
}

export function getContext(): BusState['context'] {
  return state.context
}
