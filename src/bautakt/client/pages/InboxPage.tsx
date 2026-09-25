/**
 * Posteingang: eingehende E-Mails als Eingangssensor für den Terminplan. Jede Nachricht
 * wird providerneutral entgegengenommen (heute: manuell einfügen / Webhook), regelbasiert
 * analysiert (Absender → Firma/Kontakt, Projekt, Vorgang, Datum, Art) und liefert eine
 * strukturierte Auswertung mit Auswirkung. „Änderung prüfen“ erzeugt einen Change
 * Proposal - die KI/Analyse schreibt NIE in den Masterplan.
 */

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Mail, AlertTriangle, Check, X, RefreshCw, Plus, ArrowRight, Info, Send, Link2, Unlink, Clock } from 'lucide-react'
import { api, type InboundEmail, type MailboxProvider, type MailboxStatusInfo, type SentEmail } from '../lib/api'
import { navigate, useRoute } from '../lib/router'
import { useOrg } from '../store/org'
import { useAuth } from '../store/auth'
import { useToast } from '../store/toast'
import { Badge, Button, Card, Delta, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, Tabs, Textarea } from '../components/ui'
import { formatDate, formatDateTime } from '../../shared/engine/dates'
import { EMAIL_TYPE_LABELS } from '../../shared/integrations/email/types'
import type { ImpactAnalysis } from '../../shared/engine/operations'
import { analyzeImpact } from '../../shared/engine/operations'
import { applyOperations } from '../../shared/engine/proposals'
import type { ProjectBundle, ProposalOperation } from '../../shared/types'
import type { PlanContext } from '../../shared/engine/operations'

type Filter = 'analyzed' | 'all' | 'proposed' | 'ignored'
const STATUS_LABEL: Record<InboundEmail['status'], string> = { new: 'ohne Terminbezug', analyzed: 'zu prüfen', proposed: 'Vorschlag erzeugt', ignored: 'nicht relevant' }
const STATUS_TONE: Record<InboundEmail['status'], 'neutral' | 'warn' | 'ok' | 'brand'> = { new: 'neutral', analyzed: 'warn', proposed: 'ok', ignored: 'neutral' }

export function InboxPage() {
  const org = useOrg()
  const { can } = useAuth()
  const toast = useToast()
  const route = useRoute()
  const [list, setList] = useState<InboundEmail[] | null>(null)
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [filter, setFilter] = useState<Filter>('analyzed')
  const [selectedId, setSelectedId] = useState<string | null>(route.query.get('email'))
  const [dialog, setDialog] = useState(false)
  const [form, setForm] = useState({ from_email: '', from_name: '', subject: '', body_text: '' })
  const [override, setOverride] = useState<{ project_id: string; task_id: string; new_start: string }>({ project_id: '', task_id: '', new_start: '' })
  const [bundle, setBundle] = useState<ProjectBundle | null>(null)
  const [impact, setImpact] = useState<ImpactAnalysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [mailbox, setMailbox] = useState<MailboxStatusInfo | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const [compose, setCompose] = useState<{ provider: MailboxProvider; to_email: string; cc_email: string; subject: string; body_text: string }>({ provider: 'microsoft365', to_email: '', cc_email: '', subject: '', body_text: '' })
  const [sentLog, setSentLog] = useState<SentEmail[] | null>(null)
  const [showSent, setShowSent] = useState(false)

  const loadMailbox = () => api.mailbox.status().then(setMailbox).catch(() => setMailbox(null))
  const loadSent = () => api.email.sent().then((r) => setSentLog(Array.isArray(r) ? r : [])).catch(() => setSentLog([]))
  useEffect(() => {
    void loadMailbox()
    void loadSent()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const connectedMailbox = mailbox?.accounts.find((a) => a.status === 'connected') ?? null
  const actMailbox = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try {
      await fn()
      toast.push(msg, 'success')
      await loadMailbox()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const sendMail = async () => {
    setBusy(true)
    try {
      await api.email.send({ provider: compose.provider, to_email: compose.to_email, cc_email: compose.cc_email, subject: compose.subject, body_text: compose.body_text })
      setComposeOpen(false)
      setCompose({ provider: compose.provider, to_email: '', cc_email: '', subject: '', body_text: '' })
      toast.push('E-Mail wurde über dein Postfach versendet.', 'success')
      await loadSent()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const replyTo = (m: InboundEmail) => {
    setCompose({ provider: connectedMailbox?.provider ?? 'microsoft365', to_email: m.from_email, cc_email: '', subject: m.subject.startsWith('Re:') ? m.subject : `Re: ${m.subject}`, body_text: '' })
    setComposeOpen(true)
  }


  const load = () => api.email.inbox().then((r) => setList(Array.isArray(r) ? r : [])).catch((e) => toast.push(e.message, 'error'))
  useEffect(() => {
    void load()
    api.projects.list().then((r) => setProjects(r.summaries.filter((x) => x.project.state !== 'completed').map((x) => ({ id: x.project.id, name: x.project.name })))).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const selected = useMemo(() => list?.find((m) => m.id === selectedId) ?? null, [list, selectedId])
  const shown = useMemo(() => (list ?? []).filter((m) => (filter === 'all' ? true : filter === 'analyzed' ? m.status === 'analyzed' || m.status === 'new' : m.status === filter)), [list, filter])

  // Zuordnung + Auswirkung: Bundle des Kandidatenprojekts laden und Operationen lokal auf eine Kopie anwenden
  useEffect(() => {
    if (!selected?.analysis) { setBundle(null); setImpact(null); return }
    const a = selected.analysis
    const pid = a.project_candidates[0]?.project_id ?? selected.project_id ?? ''
    const tid = a.task_candidates.find((t) => t.project_id === pid)?.task_id ?? ''
    setOverride({ project_id: pid, task_id: tid, new_start: a.new_date ?? '' })
  }, [selected])
  useEffect(() => {
    if (!override.project_id) { setBundle(null); return }
    api.projects.get(override.project_id).then(setBundle).catch(() => setBundle(null))
  }, [override.project_id])
  useEffect(() => {
    if (!bundle || !selected?.analysis) { setImpact(null); return }
    const ctx: PlanContext = { projectId: bundle.project.id, projectStart: bundle.project.start_date, projectCalendarId: bundle.project.calendar_id, calendars: bundle.calendars, exceptions: bundle.exceptions, holidayRegion: bundle.project.holiday_region, resources: bundle.resources }
    const ops = buildOps(selected.analysis.operations, override)
    if (!ops.length) { setImpact(null); return }
    try {
      let n = 0
      const state = { tasks: bundle.tasks, dependencies: bundle.dependencies }
      const after = applyOperations(state, ctx, ops, { newId: (p) => `${p}_tmp${++n}`, trades: org.trades })
      setImpact(analyzeImpact(state, after.state, ctx, []))
    } catch {
      setImpact(null)
    }
  }, [bundle, override, selected, org.trades])

  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    setBusy(true)
    try {
      await fn()
      await load()
      if (msg) toast.push(msg, 'success')
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const propose = () => act(async () => {
    if (!selected) return
    const r = await api.email.propose(selected.id, { project_id: override.project_id, task_id: override.task_id || null, new_start: override.new_start || null })
    navigate(`/projects/${r.proposal.project_id}/proposals`)
  }, 'Änderungsvorschlag erzeugt – bitte im Projekt prüfen und entscheiden.')
  const ingest = () => act(async () => {
    const r = await api.email.ingest(form)
    setDialog(false)
    setForm({ from_email: '', from_name: '', subject: '', body_text: '' })
    setSelectedId(r.id)
    setFilter('all')
  }, 'E-Mail analysiert.')

  if (!list) return <Spinner />
  const bundleTasks = bundle ? bundle.tasks.filter((t) => t.type !== 'phase' && t.type !== 'group' && t.status !== 'done') : []

  return (
    <div className="mx-auto max-w-[1200px] p-4 sm:p-6">
      <PageHeader title="Posteingang" subtitle="Ihr persönlicher Posteingang – nur Sie sehen diese Nachrichten. E-Mails als Sensor für den Terminplan: erkannt wird vorgeschlagen, entschieden wird von Ihnen" actions={<><Button onClick={() => setComposeOpen(true)}><Send size={15} /> E-Mail verfassen</Button><Button variant="primary" onClick={() => setDialog(true)}><Plus size={15} /> E-Mail einfügen</Button></>} />
      <div className="mb-4">
        <Card title="Mein Postfach" actions={connectedMailbox ? <Badge tone="ok">verbunden</Badge> : <Badge tone="neutral">nicht verbunden</Badge>}>
          {!mailbox ? <Spinner /> : (
            <div className="space-y-3 text-sm">
              {mailbox.accounts.length > 0 && (
                <ul className="space-y-2">
                  {mailbox.accounts.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2">
                      <Mail size={14} className="text-brand" /> <b>{a.provider === 'microsoft365' ? 'Microsoft 365 / Outlook' : 'Google Workspace / Gmail'}</b>
                      {a.email && <span className="text-ink-soft">· {a.email}</span>}
                      {a.last_sync_at && <span className="flex items-center gap-1 text-xs text-ink-faint"><Clock size={11} /> letzte Synchronisierung {formatDateTime(a.last_sync_at)}</span>}
                      <span className="ml-auto flex items-center gap-2">
                        <Button size="sm" loading={busy} onClick={() => actMailbox(() => api.mailbox.sync(a.provider), 'Postfach synchronisiert.').then(load)}><RefreshCw size={13} /> Jetzt synchronisieren</Button>
                        <Button size="sm" variant="ghost" loading={busy} onClick={() => actMailbox(() => api.mailbox.disconnect(a.provider), 'Postfach getrennt.')}><Unlink size={13} /> Trennen</Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {!connectedMailbox && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex items-center gap-1 text-ink-soft"><Link2 size={14} /> Eigenes Postfach verbinden – Versand und Empfang laufen dann über dein echtes Konto:</span>
                  {mailbox.setup.map((p) => (
                    <Button key={p.provider} size="sm" variant="primary" loading={busy} onClick={() => actMailbox(() => api.mailbox.connect(p.provider), 'Postfach verbunden.')} disabled={!p.ready}>
                      {p.provider === 'microsoft365' ? 'Mit Microsoft 365 verbinden' : 'Mit Google / Gmail verbinden'}
                    </Button>
                  ))}
                  {!mailbox.setup.every((p) => p.ready) && <span className="text-xs text-ink-faint">Die Freischaltung der Anbieter-Anbindung folgt – alle Oberflächen dafür stehen bereit.</span>}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={filter} onChange={setFilter} items={[{ value: 'analyzed', label: `Zu prüfen (${list.filter((m) => m.status === 'analyzed' || m.status === 'new').length})` }, { value: 'proposed', label: 'Vorschlag erzeugt' }, { value: 'ignored', label: 'Nicht relevant' }, { value: 'all', label: 'Alle' }]} />
        <span className="flex items-center gap-1 text-xs text-ink-faint"><Info size={12} /> Analyse: regelbasiert (Absender, Projekt, Datum, Schlüsselwörter). KI-Analyzer vorbereitet, nicht aktiv. Provider (Microsoft 365, Gmail, IMAP): siehe Einstellungen.</span>
      </div>
      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <Card padded={false} title={`Nachrichten (${shown.length})`}>
          {shown.length === 0 ? <div className="p-4"><EmptyState icon={<Mail size={24} />} title="Keine Nachrichten" description="Ihr Posteingang ist leer. Fügen Sie eine E-Mail ein oder verbinden Sie Ihr Postfach." /></div> : (
            <ul className="divide-y divide-line">
              {shown.map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => setSelectedId(m.id)} className={clsx('flex w-full flex-col gap-0.5 px-4 py-2.5 text-left hover:bg-surface-2', selectedId === m.id && 'bg-brand-soft/60')}>
                    <div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{m.analysis?.company_name ?? m.from_name ?? m.from_email}</span><Badge tone={STATUS_TONE[m.status]} className="ml-auto shrink-0">{STATUS_LABEL[m.status]}</Badge></div>
                    <div className="truncate text-xs text-ink-soft">{m.subject || '(kein Betreff)'}</div>
                    <div className="text-[11px] text-ink-faint">{formatDateTime(m.received_at)}{m.analysis ? ` · ${EMAIL_TYPE_LABELS[m.analysis.message_type]}` : ''}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {!selected ? <EmptyState icon={<Mail size={28} />} title="Nachricht auswählen" /> : (
          <div className="space-y-4">
            {selected.analysis && selected.analysis.operations.length > 0 && selected.status !== 'ignored' && (
              <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><div><b>Terminrelevante E-Mail erkannt</b> – {EMAIL_TYPE_LABELS[selected.analysis.message_type]}{selected.analysis.company_name ? ` von ${selected.analysis.company_name}` : ''}{selected.analysis.new_date ? ` · neuer möglicher Beginn ${formatDate(selected.analysis.new_date)}` : ''}</div></div>
            )}
            <Card title={selected.subject || '(kein Betreff)'} actions={<Badge tone={STATUS_TONE[selected.status]}>{STATUS_LABEL[selected.status]}</Badge>}>
              <div className="text-xs text-ink-faint">Von {selected.from_name ? `${selected.from_name} <${selected.from_email}>` : selected.from_email} · {formatDateTime(selected.received_at)} · Quelle: {selected.provider}</div>
              <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-surface-2 p-3 font-sans text-sm whitespace-pre-wrap">{selected.body_text}</pre>
            </Card>
            {selected.analysis && (
              <Card title="Erkannt (strukturiert)">
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                  <Row k="Absender">{selected.analysis.company_name ? <>{selected.analysis.company_name}{selected.analysis.contact_id ? ` · ${org.contacts.find((c) => c.id === selected.analysis!.contact_id)?.name ?? ''}` : ''}</> : <span className="text-warn">nicht zugeordnet – Firma/Kontakt mit dieser E-Mail-Adresse anlegen</span>}</Row>
                  <Row k="Art">{EMAIL_TYPE_LABELS[selected.analysis.message_type]} <span className="text-ink-faint">(Konfidenz {Math.round(selected.analysis.confidence * 100)} %)</span></Row>
                  <Row k="Wahrscheinliches Projekt">{selected.analysis.project_candidates[0] ? <>{selected.analysis.project_candidates[0].project_name} <span className="text-ink-faint">– {selected.analysis.project_candidates[0].why}</span></> : '–'}</Row>
                  <Row k="Wahrscheinlicher Vorgang">{selected.analysis.task_candidates[0] ? <>{selected.analysis.task_candidates[0].task_name} <span className="text-ink-faint">– {selected.analysis.task_candidates[0].why}</span></> : '–'}</Row>
                  <Row k="Bisheriger Termin">{selected.analysis.old_date ? formatDate(selected.analysis.old_date) : '–'}</Row>
                  <Row k="Neuer Termin">{selected.analysis.new_date ? <>{formatDate(selected.analysis.new_date)} {selected.analysis.delta_days !== null && <Delta days={selected.analysis.delta_days} suffix=" Tage" />}</> : '–'}</Row>
                </dl>
                {selected.analysis.hints.length > 0 && <ul className="mt-3 space-y-1 text-xs text-ink-soft">{selected.analysis.hints.map((h, i) => <li key={i} className="flex items-center gap-1"><Info size={12} /> {h.text}</li>)}</ul>}
                <p className="mt-3 text-[11px] text-ink-faint">Begründung: {selected.analysis.reason}</p>
              </Card>
            )}
            {selected.status !== 'proposed' && selected.status !== 'ignored' && selected.analysis && (
              <Card title="Zuordnung prüfen & Auswirkung">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Projekt">
                    <Select value={override.project_id} onChange={(e) => setOverride({ project_id: e.target.value, task_id: '', new_start: override.new_start })}>
                      <option value="">– wählen –</option>
                      {selected.analysis.project_candidates.length > 0 && <optgroup label="Kandidaten">{selected.analysis.project_candidates.map((c) => <option key={c.project_id} value={c.project_id}>{c.project_name}</option>)}</optgroup>}
                      <optgroup label="Alle Projekte">{projects.filter((p) => !selected.analysis!.project_candidates.some((c) => c.project_id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
                    </Select>
                  </Field>
                  <Field label="Vorgang"><Select value={override.task_id} onChange={(e) => setOverride({ ...override, task_id: e.target.value })}><option value="">– wählen –</option>{bundleTasks.map((t) => <option key={t.id} value={t.id}>{t.name} ({formatDate(t.start_date)})</option>)}</Select></Field>
                  <Field label="Neuer Beginn"><Input type="date" value={override.new_start} onChange={(e) => setOverride({ ...override, new_start: e.target.value })} /></Field>
                </div>
                <div className="mt-3 rounded-lg border border-line p-3 text-sm">
                  <div className="mb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">Auswirkung (Vorschau, ohne Speichern)</div>
                  {!impact ? <span className="text-xs text-ink-faint">{override.task_id && override.new_start ? 'wird berechnet …' : 'Vorgang und neuen Beginn wählen.'}</span> : (
                    <>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">{impact.affected.slice(0, 8).map((a) => <span key={a.id}>{a.name} <Delta days={a.shiftDays} suffix="" /></span>)}{impact.affected.length === 0 && <span className="text-ok">Keine weiteren Vorgänge betroffen.</span>}</div>
                      <div className="mt-2">Projektende: <b>{formatDate(impact.oldProjectEnd)}</b> <ArrowRight size={12} className="inline" /> <b>{formatDate(impact.newProjectEnd)}</b> <Delta days={impact.projectEndShiftDays} suffix=" Tage" /></div>
                    </>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {can('site.update') && <Button variant="primary" loading={busy} disabled={!override.project_id || (!override.task_id && !selected.analysis.operations.length)} onClick={propose}><Check size={14} /> Änderung prüfen (Vorschlag erzeugen)</Button>}
                  <Button loading={busy} onClick={() => act(() => api.email.ignore(selected.id), 'Als nicht relevant markiert.')}><X size={14} /> Als nicht relevant markieren</Button>
                  <Button variant="ghost" loading={busy} onClick={() => act(() => api.email.reanalyze(selected.id))}><RefreshCw size={14} /> Neu analysieren</Button>
                  <Button onClick={() => replyTo(selected)}><Send size={14} /> Antworten</Button>
                </div>
                <p className="mt-2 text-[11px] text-ink-faint">Der Vorschlag landet unter „Änderungsvorschläge“ des Projekts. Erst „Übernehmen“ dort verändert den Terminplan.</p>
              </Card>
            )}
            {selected.status === 'proposed' && selected.proposal_id && <Card><div className="flex items-center justify-between text-sm"><span>Vorschlag wurde erzeugt.</span><Button size="sm" onClick={() => navigate(`/projects/${selected.project_id}/proposals`)}>Zum Vorschlag <ArrowRight size={13} /></Button></div></Card>}
          </div>
        )}
      </div>

      <Modal open={dialog} onClose={() => setDialog(false)} title="E-Mail einfügen (manueller Eingang)" width="lg" footer={<><Button variant="ghost" onClick={() => setDialog(false)}>Abbrechen</Button><Button variant="primary" loading={busy} disabled={!form.from_email.includes('@') || !form.body_text.trim()} onClick={ingest}>Analysieren</Button></>}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Absender-E-Mail" required><Input type="email" value={form.from_email} onChange={(e) => setForm({ ...form, from_email: e.target.value })} placeholder="max@maler-max.de" /></Field>
            <Field label="Absendername"><Input value={form.from_name} onChange={(e) => setForm({ ...form, from_name: e.target.value })} /></Field>
          </div>
          <Field label="Betreff"><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
          <Field label="Text" required><Textarea rows={6} value={form.body_text} onChange={(e) => setForm({ ...form, body_text: e.target.value })} placeholder="Hallo, wir schaffen es leider nicht wie besprochen am 14.06. Wir können erst am 18.06. mit den Malerarbeiten beginnen." /></Field>
          <p className="text-xs text-ink-faint">Dasselbe Format nimmt der Webhook <code className="rounded bg-surface-3 px-1">POST /api/email/inbound</code> entgegen – Provider-Adapter (Microsoft 365, Gmail, IMAP) liefern darüber später automatisch.</p>
        </div>
      </Modal>

      <Modal open={composeOpen} onClose={() => setComposeOpen(false)} title="E-Mail verfassen" width="lg" footer={<><Button variant="ghost" onClick={() => setComposeOpen(false)}>Abbrechen</Button><Button variant="primary" loading={busy} disabled={!compose.to_email.includes('@') || !compose.body_text.trim()} onClick={sendMail}><Send size={14} /> Senden</Button></>}>
        <div className="space-y-3">
          {connectedMailbox ? (
            <p className="text-xs text-ink-soft">Versendet über dein verbundenes Postfach: <b>{connectedMailbox.email || (connectedMailbox.provider === 'microsoft365' ? 'Microsoft 365' : 'Gmail')}</b> – die Nachricht erscheint danach in deinem Ordner „Gesendete Elemente“.</p>
          ) : (
            <p className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">Noch ist kein Postfach verbunden – die Nachricht wird protokolliert und versendet, sobald du oben „Mein Postfach“ verbindest.</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="An" required><Input type="email" value={compose.to_email} onChange={(e) => setCompose({ ...compose, to_email: e.target.value })} placeholder="name@firma.de" /></Field>
            <Field label="Cc"><Input value={compose.cc_email} onChange={(e) => setCompose({ ...compose, cc_email: e.target.value })} /></Field>
          </div>
          <Field label="Betreff"><Input value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} /></Field>
          <Field label="Nachricht" required><Textarea rows={7} value={compose.body_text} onChange={(e) => setCompose({ ...compose, body_text: e.target.value })} placeholder="Hallo, ..." /></Field>
          {(sentLog?.length ?? 0) > 0 && (
            <details className="text-xs text-ink-soft" open={showSent} onToggle={(e) => setShowSent((e.target as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer">Gesendet ({sentLog!.length})</summary>
              <ul className="mt-2 space-y-1">
                {sentLog!.slice(0, 10).map((s) => <li key={s.id}>{formatDateTime(s.created_at)} · an {s.to_email} · {s.subject || '(kein Betreff)'} <Badge tone={s.status === 'sent' ? 'ok' : 'neutral'}>{s.status === 'sent' ? 'versendet' : 'in Warteschlange'}</Badge></li>)}
              </ul>
            </details>
          )}
        </div>
      </Modal>
    </div>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div><dt className="text-[11px] text-ink-faint">{k}</dt><dd>{children}</dd></div>
}

function buildOps(ops: ProposalOperation[], o: { task_id: string; new_start: string }): ProposalOperation[] {
  let out: ProposalOperation[] = ops.map((op) => ('task_id' in op && op.task_id && o.task_id ? { ...op, task_id: o.task_id } : op))
  if (o.new_start && o.task_id) {
    out = out.filter((op) => op.op !== 'move_task')
    out.unshift({ op: 'move_task', task_id: o.task_id, new_start: o.new_start, cascade: true })
  }
  return out
}
