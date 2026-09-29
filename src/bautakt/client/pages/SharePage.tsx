/**
 * Öffentlicher Kategorieplan (Nur-Lese, Token): mobile-first für den Empfänger.
 * „Dein nächster Einsatz“, Voraussetzungen, eigene Arbeiten, Danach, Termin bestätigen /
 * Termin nicht möglich (→ Change Proposal, kein direkter Eingriff in den Plan).
 */

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { CheckCircle2, Circle, AlertTriangle, Flag, ThumbsUp, CalendarX, GanttChartSquare } from 'lucide-react'
import { api, type SharePayload, type SharePayloadTask } from '../lib/api'
import { Button, Field, Input, Modal, Textarea, Badge } from '../components/ui'
import { formatDate, addDays } from '../../shared/engine/dates'
import { TASK_STATUS_LABELS } from '../../shared/labels'

export function SharePage({ token }: { token: string }) {
  const [data, setData] = useState<SharePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ task: SharePayloadTask; status: 'confirmed' | 'not_possible' } | null>(null)
  const [form, setForm] = useState({ contact_name: '', proposed_start: '', comment: '' })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const load = () => api.share.get(token).then((d) => { setData(d); setError(null) }).catch((e) => setError(e.message))
  useEffect(() => {
    void load()
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!dialog) return
    setBusy(true)
    try {
      await api.share.confirm(token, { task_id: dialog.task.id, status: dialog.status, proposed_start: dialog.status === 'not_possible' ? form.proposed_start || null : null, comment: form.comment, contact_name: form.contact_name })
      setDone(dialog.status === 'confirmed' ? 'Termin bestätigt – vielen Dank.' : 'Meldung gesendet. Die Projektleitung prüft die Auswirkungen und meldet sich.')
      setDialog(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (error && !data) return <div className="mx-auto max-w-md p-8 text-center"><AlertTriangle size={32} className="mx-auto text-warn" /><h1 className="mt-3 text-lg font-semibold">Link nicht verfügbar</h1><p className="mt-1 text-sm text-ink-soft">{error}</p></div>
  if (!data) return <div className="p-8 text-center text-sm text-ink-faint">Kategorieplan wird geladen …</div>

  const next = data.own.find((t) => t.status !== 'done')
  const Item = ({ t, own }: { t: SharePayloadTask; own?: boolean }) => (
    <li className={clsx('rounded-xl border bg-surface p-3', t.is_critical && t.status !== 'done' ? 'border-danger/40' : 'border-line', t.status === 'done' && 'opacity-60')}>
      <div className="flex items-start gap-2">
        {t.type === 'milestone' ? <Flag size={16} className="mt-0.5 shrink-0 text-milestone" /> : <span className={clsx('mt-1 h-8 w-1 shrink-0 rounded-full', own ? 'bg-brand' : 'bg-line-strong')} />}
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-snug">{t.name}</div>
          <div className="text-xs text-ink-faint">{t.trade ?? ''}{t.relation ? ` · ${t.relation}` : ''}</div>
          <div className="mt-1 text-sm">{formatDate(t.start)}{t.type !== 'milestone' ? ` – ${formatDate(t.end)}` : ''} <span className="text-xs text-ink-faint">· {TASK_STATUS_LABELS[t.status]}{t.type !== 'milestone' && t.status !== 'done' ? ` · ${t.progress} %` : ''}</span></div>
          {t.is_critical && t.status !== 'done' && <Badge tone="danger" className="mt-1">terminentscheidend</Badge>}
        </div>
      </div>
      {own && t.readiness && t.readiness.items.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-line pt-2 text-xs">
          {t.readiness.items.map((it) => (
            <li key={it.id} className="flex items-center gap-1.5">
              {it.state === 'ok' ? <CheckCircle2 size={14} className="text-ok" /> : it.state === 'warn' ? <AlertTriangle size={14} className="text-warn" /> : <Circle size={14} className="text-ink-faint" />}
              <span className={it.state === 'ok' ? 'text-ink-faint' : ''}>{it.label}</span><span className="ml-auto text-ink-faint">{it.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {own && t.status !== 'done' && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => { setForm({ contact_name: '', proposed_start: '', comment: '' }); setDialog({ task: t, status: 'confirmed' }) }} className="flex h-11 items-center justify-center gap-2 rounded-lg bg-ok-soft text-sm font-semibold text-ok"><ThumbsUp size={16} /> Termin bestätigen</button>
          <button type="button" onClick={() => { setForm({ contact_name: '', proposed_start: addDays(t.start, 3), comment: '' }); setDialog({ task: t, status: 'not_possible' }) }} className="flex h-11 items-center justify-center gap-2 rounded-lg bg-danger-soft text-sm font-semibold text-danger"><CalendarX size={16} /> Termin nicht möglich</button>
        </div>
      )}
    </li>
  )

  return (
    <div className="min-h-screen bg-shell pb-16">
      <header className="border-b border-line bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-xl items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-white"><GanttChartSquare size={15} /></span>
          <div className="min-w-0"><div className="text-[11px] font-semibold tracking-wider text-ink-faint uppercase">Kategorieplan · {data.scope}</div><div className="truncate font-semibold">{data.project.name}</div></div>
        </div>
      </header>
      <main className="mx-auto max-w-xl space-y-5 px-4 py-4">
        {done && <div className="rounded-xl bg-ok-soft px-4 py-3 text-sm text-ok">{done}</div>}
        {error && <div className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}
        <section className="rounded-2xl bg-sidebar p-5 text-white">
          <div className="text-xs text-white/60 uppercase">Dein nächster Einsatz</div>
          <div className="mt-1 text-3xl font-semibold">{data.next_start ? formatDate(data.next_start) : '–'}</div>
          {next && <div className="mt-1 text-sm text-white/80">{next.name}{next.readiness && next.readiness.openCount > 0 ? ` · ${next.readiness.openCount} Voraussetzung${next.readiness.openCount > 1 ? 'en' : ''} offen` : ''}</div>}
          <div className="mt-3 text-xs text-white/60">Leitung vor Ort: {data.contact.site_manager || '–'} · Projektleitung: {data.contact.project_manager || '–'} · {data.project.city}</div>
        </section>
        <Section title="Voraussetzungen – was vor dir passiert" items={data.before} />
        <Section title="Deine Arbeiten" items={data.own} own />
        <Section title="Danach" items={data.after} />
        <Section title="Meilensteine" items={data.milestones} />
        <p className="text-center text-[11px] text-ink-faint">Stand {formatDate(data.generated_at.slice(0, 10))} · Nur-Lese-Ansicht des freigegebenen Umfangs · Terminmeldungen ändern den Terminplan nicht automatisch.</p>
      </main>
      <Modal open={!!dialog} onClose={() => setDialog(null)} title={dialog?.status === 'confirmed' ? 'Termin bestätigen' : 'Termin nicht möglich'} width="sm"
        footer={<><Button variant="ghost" size="lg" onClick={() => setDialog(null)}>Abbrechen</Button><Button variant={dialog?.status === 'confirmed' ? 'primary' : 'danger'} size="lg" loading={busy} onClick={submit}>Senden</Button></>}>
        {dialog && (
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">{dialog.task.name} · geplant {formatDate(dialog.task.start)}</p>
            <Field label="Ihr Name"><Input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} className="h-11 text-base" /></Field>
            {dialog.status === 'not_possible' && <Field label="Frühestens möglich am"><Input type="date" value={form.proposed_start} onChange={(e) => setForm({ ...form, proposed_start: e.target.value })} className="h-11 text-base" /></Field>}
            <Field label="Anmerkung"><Textarea rows={3} value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} className="text-base" /></Field>
          </div>
        )}
      </Modal>
    </div>
  )

  function Section({ title, items, own }: { title: string; items: SharePayloadTask[]; own?: boolean }) {
    return (
      <section>
        <h2 className="mb-2 px-1 text-[11px] font-semibold tracking-wider text-ink-faint uppercase">{title}</h2>
        {items.length === 0 ? <p className="px-1 text-sm text-ink-faint">–</p> : <ul className="space-y-2">{items.map((t) => <Item key={t.id} t={t} own={own} />)}</ul>}
      </section>
    )
  }
}
