/**
 * Rahmen: dunkle Sidebar (global + Projektbereich), Kopfzeile mit Benachrichtigungen,
 * Inhalt. Auf dem Smartphone klappt die Sidebar ein; die Baustellenansicht ist als
 * Schnellzugriff immer erreichbar.
 */

import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  LayoutDashboard, FolderKanban, GanttChartSquare, CalendarRange, ListChecks, Users, GitCompare, FileBarChart2,
  LayoutTemplate, UserCog, Settings, Bell, LogOut, Menu, X, HardHat, FlaskConical, History, ChevronLeft, Building2, Inbox, Mail,
} from 'lucide-react'
import { Link, matchRoute, navigate, useRoute } from '../lib/router'
import { useAuth } from '../store/auth'
import { api } from '../lib/api'
import { ROLE_LABELS } from '../../shared/permissions'
import type { AppNotification, PlanningKind } from '../../shared/types'
import { Badge } from './ui'
import { formatDateTime } from '../../shared/engine/dates'

interface NavItem {
  href: string
  label: string
  icon: ReactNode
  match?: (path: string) => boolean
}

/** Bewusst schlanke Hauptnavigation (§5); Portfolio, Meilensteine, Kalender, Baustelle hängen an Übersicht/Lookahead/Einstellungen. */
const GLOBAL_NAV: NavItem[] = [
  { href: '/', label: 'Übersicht', icon: <LayoutDashboard size={17} />, match: (p) => p === '/' || p === '/portfolio' || p === '/milestones' || p === '/notifications' },
  { href: '/projects', label: 'Projekte', icon: <FolderKanban size={17} />, match: (p) => p === '/projects' || p === '/projects/new' },
  { href: '/schedule', label: 'Terminplan', icon: <GanttChartSquare size={17} /> },
  { href: '/lookahead', label: 'Lookahead', icon: <CalendarRange size={17} />, match: (p) => p === '/lookahead' || p === '/site' },
  { href: '/resources', label: 'Gewerke & Ressourcen', icon: <Users size={17} /> },
  { href: '/templates', label: 'Vorlagen', icon: <LayoutTemplate size={17} /> },
  { href: '/reports', label: 'Berichte', icon: <FileBarChart2 size={17} /> },
]
const BOTTOM_NAV: NavItem[] = [
  { href: '/inbox', label: 'Posteingang', icon: <Mail size={17} /> },
  { href: '/team', label: 'Team', icon: <UserCog size={17} /> },
  { href: '/settings', label: 'Einstellungen', icon: <Settings size={17} />, match: (p) => p === '/settings' || p === '/calendar' },
]

function projectNav(id: string, kind: PlanningKind | undefined): NavItem[] {
  const b = `/projects/${id}`
  const construction = kind === 'construction' || kind === undefined
  return [
    { href: b, label: 'Cockpit', icon: <Building2 size={17} />, match: (p) => p === b || p === `${b}/milestones` },
    { href: `${b}/gantt`, label: 'Terminplan', icon: <GanttChartSquare size={17} /> },
    { href: `${b}/tasks`, label: 'Vorgänge', icon: <ListChecks size={17} /> },
    { href: `${b}/lookahead`, label: 'Lookahead', icon: <CalendarRange size={17} /> },
    { href: `${b}/trades`, label: construction ? 'Gewerke' : 'Beteiligte', icon: <Users size={17} /> },
    { href: `${b}/proposals`, label: 'Änderungsvorschläge', icon: <Inbox size={17} /> },
    { href: `${b}/baseline`, label: 'Soll-Ist / Baseline', icon: <GitCompare size={17} /> },
    { href: `${b}/scenarios`, label: 'Szenarien', icon: <FlaskConical size={17} /> },
    { href: `${b}/reports`, label: 'Berichte', icon: <FileBarChart2 size={17} /> },
    { href: `${b}/history`, label: 'Historie', icon: <History size={17} /> },
    { href: `${b}/settings`, label: 'Projektdaten', icon: <Settings size={17} /> },
  ]
}

export function AppShell({ children, projectName, planningKind }: { children: ReactNode; projectName?: string; planningKind?: PlanningKind }) {
  const { path } = useRoute()
  const { session, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const projectMatch = matchRoute('/projects/:id', path) ?? matchRoute('/projects/:id/:sub', path)
  const projectId = projectMatch && projectMatch.id !== 'new' ? projectMatch.id : null

  useEffect(() => setOpen(false), [path])

  const isActive = (it: NavItem) => (it.match ? it.match(path) : path.startsWith(it.href))

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {projectId ? (
        <>
          <Link href="/projects" className="mb-2 flex items-center gap-1.5 px-2 text-xs text-sidebar-ink/70 hover:text-white">
            <ChevronLeft size={14} /> Alle Projekte
          </Link>
          <div className="mb-1 truncate px-2 text-[11px] font-semibold tracking-wider text-sidebar-ink/60 uppercase" title={projectName}>
            {projectName ?? 'Projekt'}
          </div>
          {projectNav(projectId, planningKind).map((it) => (
            <NavLink key={it.href} item={it} active={isActive(it)} />
          ))}
          <div className="mt-4 mb-1 px-2 text-[11px] font-semibold tracking-wider text-sidebar-ink/60 uppercase">Unternehmen</div>
          {GLOBAL_NAV.slice(0, 2).map((it) => (
            <NavLink key={it.href} item={it} active={false} />
          ))}
        </>
      ) : (
        GLOBAL_NAV.map((it) => <NavLink key={it.href} item={it} active={isActive(it)} />)
      )}
    </nav>
  )
  const bottomNav = (
    <nav className="flex flex-col gap-0.5 border-t border-sidebar-line px-3 py-2">
      {BOTTOM_NAV.map((it) => <NavLink key={it.href} item={it} active={isActive(it)} />)}
    </nav>
  )

  return (
    <div className="flex h-full min-h-screen">
      {/* Sidebar Desktop */}
      <aside className="hidden w-60 shrink-0 flex-col bg-sidebar text-sidebar-ink lg:flex">
        <Brand />
        <div className="flex-1 overflow-y-auto px-3 py-2">{nav}</div>
        {bottomNav}
        <UserBox name={session?.user.name ?? ''} role={session ? ROLE_LABELS[session.role] : ''} org={session?.org.name ?? ''} onLogout={logout} />
      </aside>

      {/* Sidebar Mobile */}
      {open && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <aside className="flex w-72 flex-col bg-sidebar text-sidebar-ink shadow-2xl">
            <div className="flex items-center justify-between pr-2">
              <Brand />
              <button type="button" className="p-2 text-sidebar-ink" onClick={() => setOpen(false)} aria-label="Menü schließen">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2">{nav}</div>
            {bottomNav}
            <UserBox name={session?.user.name ?? ''} role={session ? ROLE_LABELS[session.role] : ''} org={session?.org.name ?? ''} onLogout={logout} />
          </aside>
          <div className="flex-1 bg-ink/40" onClick={() => setOpen(false)} />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur">
          <button type="button" className="rounded-md p-1.5 text-ink-soft hover:bg-surface-3 lg:hidden" onClick={() => setOpen(true)} aria-label="Menü">
            <Menu size={20} />
          </button>
          <div className="min-w-0 flex-1 truncate text-sm text-ink-soft">{session?.org.name}</div>
          <Link href={projectId && planningKind && planningKind !== 'construction' ? `/site?project=${projectId}` : '/site'} className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink-soft hover:bg-surface-2">
            <HardHat size={14} /> <span className="hidden sm:inline">{planningKind && planningKind !== 'construction' ? 'Heute' : 'Baustelle heute'}</span>
          </Link>
          <NotificationBell />
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}

function Brand() {
  return (
    <Link href="/" className="flex h-14 items-center gap-2.5 px-5">
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-white">
        <GanttChartSquare size={16} />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-white">BauTakt</span>
    </Link>
  )
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      className={clsx(
        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition',
        active ? 'bg-white/10 text-white' : 'text-sidebar-ink hover:bg-white/5 hover:text-white',
      )}
    >
      <span className={clsx(active ? 'text-white' : 'text-sidebar-ink/70')}>{item.icon}</span>
      {item.label}
    </Link>
  )
}

function UserBox({ name, role, org, onLogout }: { name: string; role: string; org: string; onLogout: () => void }) {
  return (
    <div className="border-t border-sidebar-line px-4 py-3">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white">
          {name
            .split(' ')
            .map((p) => p[0])
            .slice(0, 2)
            .join('')}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-white">{name}</div>
          <div className="truncate text-[11px] text-sidebar-ink/70">
            {role} · {org}
          </div>
        </div>
        <button type="button" onClick={onLogout} title="Abmelden" className="rounded-md p-1.5 text-sidebar-ink/70 hover:bg-white/10 hover:text-white">
          <LogOut size={15} />
        </button>
      </div>
    </div>
  )
}

function NotificationBell() {
  const [items, setItems] = useState<AppNotification[]>([])
  const [open, setOpen] = useState(false)
  const load = () => api.notifications.list().then(setItems).catch(() => {})
  useEffect(() => {
    void load()
    const t = window.setInterval(load, 60_000)
    return () => window.clearInterval(t)
  }, [])
  const unread = items.filter((n) => !n.read_at).length
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="relative rounded-md p-1.5 text-ink-soft hover:bg-surface-3" aria-label="Benachrichtigungen">
        <Bell size={18} />
        {unread > 0 && <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">{unread}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="animate-fade-in absolute right-0 z-50 mt-1 w-[360px] max-w-[92vw] overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <span className="text-sm font-semibold">Benachrichtigungen</span>
              <button
                type="button"
                className="text-xs text-brand hover:underline"
                onClick={() => api.notifications.readAll().then(load)}
              >
                Alle gelesen
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {items.length === 0 && <div className="px-3 py-6 text-center text-sm text-ink-faint">Keine Benachrichtigungen</div>}
              {items.slice(0, 30).map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    if (!n.read_at) api.notifications.read(n.id).then(load)
                    if (n.project_id) navigate(`/projects/${n.project_id}`)
                    setOpen(false)
                  }}
                  className={clsx('flex w-full flex-col items-start gap-0.5 border-b border-line px-3 py-2.5 text-left hover:bg-surface-2', !n.read_at && 'bg-brand-soft/40')}
                >
                  <div className="flex w-full items-center gap-2">
                    <Badge tone={n.severity === 'critical' ? 'danger' : n.severity === 'warning' ? 'warn' : 'brand'} dot>
                      {n.severity === 'critical' ? 'Kritisch' : n.severity === 'warning' ? 'Warnung' : 'Info'}
                    </Badge>
                    <span className="ml-auto text-[11px] text-ink-faint">{formatDateTime(n.created_at)}</span>
                  </div>
                  <div className="text-sm font-medium text-ink">{n.title}</div>
                  <div className="text-xs text-ink-soft">{n.message}</div>
                </button>
              ))}
            </div>
            <Link href="/notifications" className="block border-t border-line px-3 py-2 text-center text-xs text-brand hover:underline" onClick={() => setOpen(false)}>
              Alle anzeigen
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
