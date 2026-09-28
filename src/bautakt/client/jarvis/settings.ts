/**
 * Jarvis-Einstellungen je Nutzer (im Browser gespeichert, nach dem Muster von bautakt.gantt.v1).
 */

export interface JarvisSettings {
  /** „Hi Jarvis“ zum Aufwecken - nur auf ausdrücklichen Wunsch (Mikrofon hört dauerhaft mit) */
  wakeWord: boolean
  /** Antworten vorlesen */
  speak: boolean
  /** Natürliche KI-Stimme oder die Stimme des Browsers */
  voice: 'cloud' | 'browser'
  /** Die Ansicht folgt Jarvis (Projekt öffnen, Vorgang zeigen) */
  autoFollow: boolean
}

export const DEFAULT_SETTINGS: JarvisSettings = { wakeWord: false, speak: true, voice: 'cloud', autoFollow: true }

const KEY = 'bautakt.jarvis.v1'

export function loadSettings(userId: string): JarvisSettings {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Partial<JarvisSettings>>
    return { ...DEFAULT_SETTINGS, ...(all[userId] ?? {}) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(userId: string, settings: JarvisSettings): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Partial<JarvisSettings>>
    all[userId] = settings
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* privater Modus o. ä. */
  }
}
