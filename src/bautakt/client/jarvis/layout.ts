/**
 * Größe und Position des Jarvis-Fensters - je Nutzer im Browser gespeichert, nach dem
 * Muster von settings.ts. `null` = Standardposition (unten links, Standardgröße).
 */

export interface JarvisLayout {
  left: number
  top: number
  width: number
  height: number
}

const KEY = 'bautakt.jarvis.layout.v1'

export function loadLayout(userId: string | null): JarvisLayout | null {
  if (!userId) return null
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, JarvisLayout | undefined>
    const l = all[userId]
    return l && Number.isFinite(l.left) && Number.isFinite(l.top) && Number.isFinite(l.width) && Number.isFinite(l.height) ? l : null
  } catch {
    return null
  }
}

export function saveLayout(userId: string | null, layout: JarvisLayout): void {
  if (!userId) return
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, JarvisLayout | undefined>
    all[userId] = layout
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* privater Modus o. ä. */
  }
}
