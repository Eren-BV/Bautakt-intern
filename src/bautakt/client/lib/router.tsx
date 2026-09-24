/**
 * Minimaler History-Router ohne Abhängigkeit: `useRoute()` liefert Pfad + Query,
 * `navigate()` wechselt, `<Link>` rendert Anker mit Client-Navigation.
 * Muster: "/projects/:id/gantt" → `matchRoute(pattern, path)` gibt Parameter zurück.
 */

import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'

const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  notify()
}

if (typeof window !== 'undefined') window.addEventListener('popstate', notify)

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function snapshot() {
  return location.pathname + location.search
}

function serverSnapshot() {
  return '/'
}

export function useRoute(): { path: string; query: URLSearchParams; full: string } {
  const full = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  const [path, qs] = full.split('?')
  return { path, query: new URLSearchParams(qs ?? ''), full }
}

export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const s = path.split('/').filter(Boolean)
  if (p.length !== s.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i])
    else if (p[i] !== s[i]) return null
  }
  return params
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(href)
  }
  return <a href={href} onClick={handle} {...rest} />
}
