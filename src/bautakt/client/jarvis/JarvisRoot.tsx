/**
 * Hängt Jarvis in die App (neben den Seiten, also überall inkl. Tagesansicht):
 * Anmeldung weiterreichen, Alt+J und Esc abfangen, Aktivität für „Hi Jarvis“ melden.
 */

import { useEffect } from 'react'
import { useRoute } from '../lib/router'
import { useAuth } from '../store/auth'
import { jarvis, useJarvis } from './engine'
import { JarvisUi } from './JarvisPanel'

export function JarvisRoot() {
  const { session } = useAuth()
  const { path } = useRoute()
  const state = useJarvis()
  const userId = session?.user.id
  const orgId = session?.org.id

  useEffect(() => {
    if (userId && orgId) jarvis.configure({ userId, orgId })
  }, [userId, orgId])

  useEffect(() => jarvis.attach(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // e.code statt e.key: Auf dem Mac erzeugt Option+J sonst „∆“
      if (e.code === 'KeyJ' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) jarvis.activate()
        return
      }
      if (e.key === 'Escape') jarvis.escape()
      jarvis.touch()
    }
    const onPointer = () => jarvis.touch()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [])

  if (!state.ready) return null
  return <JarvisUi state={state} noSidebar={path === '/site' || path.startsWith('/site/')} />
}
