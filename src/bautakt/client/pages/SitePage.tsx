/**
 * Baustellen-Ansicht "HEUTE": bewusst ohne Sidebar, große Touch-Ziele, vier
 * Schnellaktionen pro Vorgang. Bei "Gefährdet"/"Verzögert" Grund, Kommentar, neue Prognose.
 * Foto-Anhänge: Architektur vorbereitet (AttachmentMeta), Upload folgt mit Storage-Adapter.
 */

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, Camera, Check, AlertTriangle, Clock, ThumbsUp, RefreshCw, ChevronDown, CheckCircle2, Circle } from 'lucide-react'
import { api, type SiteTodayEntry } from '../lib/api'
import { Link, navigate } from '../lib/router'
import { useOrg } from '../store/org'
import { useAuth } from '../store/auth'
import { useToast } from '../store/toast'
import { Button, Field, Input, Modal, Select, Spinner, Textarea, ErrorBox, EmptyState } from '../components/ui'
import type { DelayReason, SiteFlag, Task } from '../../shared/types'
import { DELAY_REASON_LABELS } from '../../shared/labels'
import { formatDate, todayISO, addDays } from '../../shared/engine/dates'

type Row = SiteTodayEntry['tasks'][number]

export function SitePage() {
  const org = useOrg()
  const { session, can } = useAuth()
  const toast = useToast()
  const [data, setData] = useState<SiteTodayEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [projectFilter, setProjectFilter] = useState(() => new URLSearchParams(location.search).get('project') ?? '')
  const [dialog, setDialog] = useState<{ project: string; task: Row; flag: SiteFlag } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const today = todayISO()

  const load = () => api.site.today().then((d) => { setData(d); setError(null) }).catch((e) => setError(e.message))
  useEffect(() => {
    void load()
  }, [])

  const entries = useMemo(() => (data ?? []).filter((e) => !projectFilter || e.project.id === projectFilter), [data, projectFilter])
  const total = entries.reduce((n, e) => n + e.tasks.length, 0)

  const quick = async (projectId: string, task: Row, flag: SiteFlag) => {
    if (flag === 'at_risk' || flag === 'delayed') {
      setDialog({ project: projectId, task, flag })
      return
    }
    setBusy(task.id)
    try {
      await api.projects.siteUpdate(projectId, task.id, { flag, progress: flag === 'done' ? 100 : Math.max(task.progress, task.planned_progress) })
      toast.push(flag === 'done' ? `${task.name} erledigt.` : `${task.name}: im Plan.`, 'success')
      await load()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="min-h-screen bg-shell pb-24">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Link href="/" className="rounded-md p-1.5 text-ink-soft hover:bg-surface-3" aria-label="Zurück"><ArrowLeft size={20} /></Link>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold tracking-wider text-ink-faint uppercase">{entries.length === 1 && entries[0].project.planning_kind !== 'construction' ? 'Tagesansicht' : 'Baustelle'}</div>
            <div className="truncate text-lg font-semibold leading-tight">HEUTE · {formatDate(today, 'long')}</div>
          </div>
          <button type="button" onClick={load} className="rounded-md p-2 text-ink-soft hover:bg-surface-3" aria-label="Aktualisieren"><RefreshCw size={18} /></button>
        </div>
        {data && data.length > 1 && (
          <div className="mx-auto mt-2 max-w-2xl">
            <div className="relative">
              <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className="h-11 w-full appearance-none rounded-xl border border-line bg-surface px-4 pr-10 text-base font-medium">
                <option value="">Alle Projekte ({data.reduce((n, e) => n + e.tasks.length, 0)})</option>
                {data.map((e) => <option key={e.project.id} value={e.project.id}>{e.project.name} ({e.tasks.length})</option>)}
              </select>
              <ChevronDown size={18} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-faint" />
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-2xl space-y-6 px-4 py-4">
        {error && <ErrorBox message={error} onRetry={load} />}
        {!data && !error && <Spinner />}
        {data && total === 0 && <EmptyState title="Heute keine offenen Vorgänge" description="Alle für heute geplanten Arbeiten sind erledigt oder es ist nichts eingeplant." action={<Button onClick={() => navigate('/lookahead')}>Lookahead ansehen</Button>} />}
        {entries.map((e) => (
          <section key={e.project.id}>
            <h2 className="mb-2 flex items-baseline justify-between px-1">
              <span className="text-base font-semibold">{e.project.name}</span>
              <span className="text-xs text-ink-faint">{e.project.city}</span>
            </h2>
            <div className="space-y-3">
              {e.tasks.map((t) => {
                const overdue = t.end_date < today
                const behind = t.planned_progress - t.progress > 15
                return (
                  <article key={t.id} className={clsx('rounded-2xl border bg-surface p-4 shadow-sm', t.status === 'delayed' ? 'border-danger/40' : t.status === 'blocked' || t.status === 'at_risk' ? 'border-warn/40' : 'border-line')}>
                    <div className="flex items-start gap-3">
                      <span className="mt-1 h-10 w-1.5 shrink-0 rounded-full" style={{ background: org.tradeColor(t.trade_id) }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[17px] font-semibold leading-snug">{t.name}</div>
                        <div className="mt-0.5 text-sm text-ink-soft">{org.tradeName(t.trade_id)}{t.company_id ? ` · ${org.companyName(t.company_id)}` : ''}</div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-faint">
                          <span>{formatDate(t.start_date)} – {formatDate(t.end_date)}</span>
                          {t.is_critical && <span className="font-medium text-danger">kritischer Pfad</span>}
                          {overdue && <span className="font-medium text-danger">überfällig</span>}
                          {t.status === 'delayed' && <span className="font-medium text-danger">verzögert gemeldet</span>}
                          {(t.status === 'blocked' || t.status === 'at_risk') && <span className="font-medium text-warn">{t.status === 'blocked' ? 'blockiert' : 'gefährdet'}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-xl bg-surface-2 px-3 py-2"><div className="text-[11px] text-ink-faint uppercase">Soll-Fortschritt</div><div className="text-lg font-semibold">{t.planned_progress} %</div></div>
                      <div className={clsx('rounded-xl px-3 py-2', behind ? 'bg-danger-soft' : 'bg-surface-2')}><div className="text-[11px] text-ink-faint uppercase">Ist-Fortschritt</div><div className={clsx('text-lg font-semibold', behind && 'text-danger')}>{t.progress} %</div></div>
                    </div>
                    {t.readiness.items.length > 0 && (
                      <div className="mt-3 rounded-xl border border-line px-3 py-2">
                        <div className={clsx('text-[11px] font-semibold uppercase', t.readiness.openCount ? 'text-warn' : 'text-ok')}>{t.readiness.label}</div>
                        <ul className="mt-1 space-y-0.5 text-xs">
                          {t.readiness.items.map((it) => <li key={it.id} className="flex items-center gap-1.5">{it.state === 'ok' ? <CheckCircle2 size={14} className="text-ok" /> : it.state === 'warn' ? <AlertTriangle size={14} className="text-warn" /> : <Circle size={14} className="text-ink-faint" />}<span className={it.state === 'ok' ? 'text-ink-faint' : ''}>{it.label}</span><span className="ml-auto text-ink-faint">{it.detail}</span></li>)}
                        </ul>
                      </div>
                    )}
                    {can('site.update') && (
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <QuickButton icon={<ThumbsUp size={18} />} label="IM PLAN" tone="ok" busy={busy === t.id} onClick={() => quick(e.project.id, t, 'on_track')} />
                        <QuickButton icon={<AlertTriangle size={18} />} label="GEFÄHRDET" tone="warn" busy={busy === t.id} onClick={() => quick(e.project.id, t, 'at_risk')} />
                        <QuickButton icon={<Clock size={18} />} label="VERZÖGERT" tone="danger" busy={busy === t.id} onClick={() => quick(e.project.id, t, 'delayed')} />
                        <QuickButton icon={<Check size={18} />} label="ERLEDIGT" tone="done" busy={busy === t.id} onClick={() => quick(e.project.id, t, 'done')} />
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          </section>
        ))}
        <p className="pt-2 text-center text-xs text-ink-faint">Angemeldet als {session?.user.name}</p>
      </main>

      <SiteUpdateDialog dialog={dialog} onClose={() => setDialog(null)} onDone={async () => { setDialog(null); await load() }} />
    </div>
  )
}

function QuickButton({ icon, label, tone, onClick, busy }: { icon: React.ReactNode; label: string; tone: 'ok' | 'warn' | 'danger' | 'done'; onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={clsx(
        'flex h-14 items-center justify-center gap-2 rounded-xl text-sm font-bold tracking-wide transition active:scale-[0.98] disabled:opacity-50',
        tone === 'ok' && 'bg-ok-soft text-ok hover:bg-ok hover:text-white',
        tone === 'warn' && 'bg-warn-soft text-warn hover:bg-warn hover:text-white',
        tone === 'danger' && 'bg-danger-soft text-danger hover:bg-danger hover:text-white',
        tone === 'done' && 'bg-ink text-white hover:bg-black',
      )}
    >
      {icon} {label}
    </button>
  )
}

function SiteUpdateDialog({ dialog, onClose, onDone }: { dialog: { project: string; task: Row; flag: SiteFlag } | null; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast()
  const [reason, setReason] = useState<DelayReason>('material')
  const [comment, setComment] = useState('')
  const [progress, setProgress] = useState(0)
  const [forecast, setForecast] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (dialog) {
      setReason('material')
      setComment('')
      setProgress(dialog.task.progress)
      setForecast(dialog.flag === 'delayed' ? addDays(dialog.task.end_date, 3) : '')
    }
  }, [dialog])
  if (!dialog) return null
  const t: Task = dialog.task
  const submit = async () => {
    setBusy(true)
    try {
      await api.projects.siteUpdate(dialog.project, t.id, { flag: dialog.flag, progress, comment, delay_reason: reason, new_forecast_end: forecast || null })
      toast.push('Meldung gespeichert – Terminplan aktualisiert.', 'success')
      await onDone()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={`${dialog.flag === 'delayed' ? 'Verzögerung' : 'Gefährdung'} melden: ${t.name}`} width="sm"
      footer={<><Button variant="ghost" size="lg" onClick={onClose}>Abbrechen</Button><Button variant={dialog.flag === 'delayed' ? 'danger' : 'primary'} size="lg" loading={busy} onClick={submit}>Melden</Button></>}>
      <div className="space-y-4">
        <Field label="Grund">
          <Select value={reason} onChange={(e) => setReason(e.target.value as DelayReason)} className="h-11 text-base">
            {(Object.keys(DELAY_REASON_LABELS) as DelayReason[]).map((r) => <option key={r} value={r}>{DELAY_REASON_LABELS[r]}</option>)}
          </Select>
        </Field>
        <Field label={`Ist-Fortschritt: ${progress} %`}>
          <input type="range" min={0} max={100} step={5} value={progress} onChange={(e) => setProgress(Number(e.target.value))} className="h-8 w-full accent-brand" />
        </Field>
        <Field label="Neue Prognose (Ende)" hint={dialog.flag === 'delayed' ? 'Verschiebt abhängige Vorgänge automatisch' : 'Optional'}>
          <Input type="date" value={forecast} min={t.end_date} onChange={(e) => setForecast(e.target.value)} className="h-11 text-base" />
        </Field>
        <Field label="Kommentar">
          <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Was ist passiert? Was wird gebraucht?" className="text-base" />
        </Field>
        <button type="button" disabled className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong py-3 text-sm text-ink-faint" title="Foto-Upload folgt (Storage-Adapter)">
          <Camera size={16} /> Foto hinzufügen (bald verfügbar)
        </button>
      </div>
    </Modal>
  )
}
