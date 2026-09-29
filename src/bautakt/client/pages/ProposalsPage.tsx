/**
 * Änderungsvorschläge (Partnerfirmen, E-Mail-Eingang, BuildFlow-Abgleich, intern, später
 * KI): Masterplan wird nie automatisch geändert. Projektleiter sieht Operationen
 * (hinzugefügt / geändert / entfernt), Auswirkungsanalyse und Regelverstöße und entscheidet:
 * Übernehmen · Ablehnen · Bearbeiten (als Szenario öffnen).
 */

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Inbox, Check, X, ArrowRight, Plus, FlaskConical, AlertTriangle, Mail, Workflow, Link2, PenLine } from 'lucide-react'
import { useProject } from '../store/project'
import { useOrg } from '../store/org'
import { useToast } from '../store/toast'
import { api, type ProposalImpact } from '../lib/api'
import { navigate } from '../lib/router'
import { ProjectHeader } from '../components/ProjectHeader'
import { Badge, Button, Card, Delta, EmptyState, Field, Input, Modal, Select, Spinner, Tabs, Textarea } from '../components/ui'
import type { ChangeProposal } from '../../shared/types'
import { formatDate, formatDateTime } from '../../shared/engine/dates'
import { CHANGE_SOURCE_LABELS, DELAY_REASON_LABELS, PROPOSAL_ORIGIN_LABELS } from '../../shared/labels'
import { flattenTree } from '../../shared/engine/operations'

const ORIGIN_ICON: Record<ChangeProposal['origin_kind'], React.ReactNode> = { share_link: <Link2 size={12} />, manual: <PenLine size={12} />, email: <Mail size={12} />, buildflow: <Workflow size={12} />, ai: <span>✨</span> }
const KIND_TONE: Record<'added' | 'changed' | 'removed', string> = { added: 'bg-ok-soft text-ok', changed: 'bg-brand-soft text-brand', removed: 'bg-danger-soft text-danger' }
const KIND_LABEL: Record<'added' | 'changed' | 'removed', string> = { added: 'neu', changed: 'geändert', removed: 'entfernt' }

export function ProposalsPage() {
  const p = useProject()
  const org = useOrg()
  const toast = useToast()
  const [list, setList] = useState<ChangeProposal[] | null>(null)
  const [scope, setScope] = useState<'open' | 'all'>('open')
  const [impact, setImpact] = useState<Record<string, ProposalImpact>>({})
  const [note, setNote] = useState<Record<string, string>>({})
  const [dialog, setDialog] = useState(false)
  const [form, setForm] = useState({ task_id: '', proposed_start: '', reason: 'subcontractor', comment: '' })

  const load = () => api.proposals.list(p.projectId).then(setList).catch((e) => toast.push(e.message, 'error'))
  useEffect(() => {
    void load()
  }, [p.projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    for (const pr of list ?? []) if (pr.status === 'open' && !impact[pr.id]) api.proposals.impact(p.projectId, pr.id).then((r) => setImpact((m) => ({ ...m, [pr.id]: r }))).catch(() => {})
  }, [list]) // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (pr: ChangeProposal, decision: 'accept' | 'reject') => {
    try {
      await api.proposals.decide(p.projectId, pr.id, decision, note[pr.id])
      toast.push(decision === 'accept' ? 'Vorschlag übernommen – Terminplan aktualisiert.' : 'Vorschlag abgelehnt.', 'success')
      setImpact({})
      await p.reload()
      await load()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const edit = async (pr: ChangeProposal) => {
    try {
      const sc = await api.proposals.toScenario(p.projectId, pr.id)
      toast.push('Vorschlag als Szenario geöffnet – anpassen, vergleichen, dann übernehmen oder verwerfen.', 'success')
      p.enterScenario(sc)
      navigate(`/projects/${p.projectId}/gantt`)
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const create = async () => {
    try {
      await api.proposals.create(p.projectId, { task_id: form.task_id, proposed_start: form.proposed_start || null, reason: form.reason, comment: form.comment })
      setDialog(false)
      await load()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }

  if (!p.bundle || !list) return <Spinner />
  const taskName = (id: string | null) => (id ? (p.plan.tasks.find((t) => t.id === id)?.name ?? '(gelöscht)') : '')
  const shown = list.filter((x) => scope === 'all' || x.status === 'open')

  return (
    <div>
      <ProjectHeader title="Änderungsvorschläge" actions={p.canEdit && <Button onClick={() => { setForm({ task_id: p.plan.tasks.find((t) => t.type !== 'phase')?.id ?? '', proposed_start: '', reason: 'subcontractor', comment: '' }); setDialog(true) }}><Plus size={15} /> Vorschlag erfassen</Button>} />
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={scope} onChange={setScope} items={[{ value: 'open', label: `Offen (${list.filter((x) => x.status === 'open').length})` }, { value: 'all', label: 'Alle' }]} />
          <span className="text-xs text-ink-faint">Vorschlag → Auswirkung → Mensch entscheidet. Der Masterplan wird nie automatisch geändert.</span>
        </div>
        {shown.length === 0 && <EmptyState icon={<Inbox size={28} />} title="Keine offenen Vorschläge" description="Meldungen über den Kategorieplan-Link, terminrelevante E-Mails und BuildFlow-Abgleiche landen hier." />}
        {shown.map((pr) => {
          const im = impact[pr.id]
          const t = pr.task_id ? p.plan.tasks.find((x) => x.id === pr.task_id) : undefined
          const simple = !pr.operations?.length
          return (
            <Card key={pr.id}>
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{pr.title || taskName(pr.task_id) || 'Änderungsvorschlag'}</h3>
                    <Badge tone="neutral">{CHANGE_SOURCE_LABELS[pr.source]}</Badge>
                    <Badge tone="brand"><span className="inline-flex items-center gap-1">{ORIGIN_ICON[pr.origin_kind]} {PROPOSAL_ORIGIN_LABELS[pr.origin_kind]}</span></Badge>
                    {pr.status !== 'open' && <Badge tone={pr.status === 'accepted' ? 'ok' : 'danger'}>{pr.status === 'accepted' ? 'übernommen' : 'abgelehnt'}</Badge>}
                  </div>
                  <div className="mt-1 text-sm text-ink-soft">{pr.submitted_by_name || 'Unbekannt'} · {formatDateTime(pr.created_at)}{pr.reason && DELAY_REASON_LABELS[pr.reason as keyof typeof DELAY_REASON_LABELS] ? ` · Grund: ${DELAY_REASON_LABELS[pr.reason as keyof typeof DELAY_REASON_LABELS]}` : ''}</div>
                  {pr.comment && <p className="mt-1 text-sm">„{pr.comment}“</p>}
                  {pr.origin_kind === 'email' && pr.origin_ref && <button type="button" className="mt-1 text-xs text-brand hover:underline" onClick={() => navigate(`/inbox?email=${pr.origin_ref}`)}>E-Mail im Posteingang öffnen</button>}
                </div>
                {simple && (
                  <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
                    <div><div className="text-[11px] text-ink-faint">Geplant</div><div className="font-medium">{t ? formatDate(t.start_date) : '–'}</div></div>
                    <ArrowRight size={14} className="text-ink-faint" />
                    <div><div className="text-[11px] text-ink-faint">Gemeldet</div><div className="font-medium">{pr.proposed_start ? formatDate(pr.proposed_start) : pr.proposed_end ? `Ende ${formatDate(pr.proposed_end)}` : '–'}</div></div>
                    {t && pr.proposed_start && <div className="pl-2"><div className="text-[11px] text-ink-faint">Differenz</div><div className="font-medium"><Delta days={Math.round((Date.parse(pr.proposed_start) - Date.parse(t.start_date)) / 86400000)} suffix=" Tage" /></div></div>}
                  </div>
                )}
              </div>
              {pr.status === 'open' && (
                <div className="mt-3 rounded-lg border border-line p-3">
                  {!im ? <div className="text-xs text-ink-faint">Auswirkungen werden berechnet …</div> : (
                    <>
                      {!simple && (
                        <div className="mb-3">
                          <div className="mb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">Vorgeschlagene Änderungen ({im.operations.length})</div>
                          <ul className="space-y-1 text-sm">
                            {im.operations.map((o, i) => (
                              <li key={i} className="flex items-start gap-2"><span className={clsx('mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', KIND_TONE[o.kind])}>{KIND_LABEL[o.kind]}</span><span>{o.text}</span></li>
                            ))}
                          </ul>
                          {im.warnings.length > 0 && <div className="mt-2 text-xs text-warn">{im.warnings.join(' · ')}</div>}
                        </div>
                      )}
                      <div className="mb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">Auswirkungen bei Übernahme</div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                        {im.impact.affected.slice(0, 8).map((a) => <span key={a.id}>{a.name} <Delta days={a.shiftDays} suffix="" /></span>)}
                        {im.impact.affected.length > 8 && <span className="text-ink-faint">+{im.impact.affected.length - 8} weitere</span>}
                        {im.impact.affected.length === 0 && <span className="text-ok">Keine weiteren Vorgänge betroffen.</span>}
                      </div>
                      <div className="mt-2 text-sm">Projektende: <b>{formatDate(im.impact.oldProjectEnd)}</b> → <b>{formatDate(im.impact.newProjectEnd)}</b> <Delta days={im.impact.projectEndShiftDays} suffix=" Tage" /></div>
                      {im.new_constraints.length > 0 && <div className="mt-1 text-xs text-ink-soft">Neue Voraussetzungen: {im.new_constraints.map((c) => c.title).join(', ')}</div>}
                      {im.new_rule_violations.length > 0 && (
                        <div className="mt-2 rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">
                          <div className="flex items-center gap-1 font-semibold"><AlertTriangle size={13} /> {im.new_rule_violations.length} neue Regelverstöße</div>
                          <ul className="mt-1 list-disc pl-5">{im.new_rule_violations.slice(0, 4).map((v, i) => <li key={i}><b>{v.rule_name}:</b> {v.message}</li>)}</ul>
                        </div>
                      )}
                    </>
                  )}
                  {p.canEdit && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Input placeholder="Entscheidungsnotiz (optional)" className="h-8 w-64 text-xs" value={note[pr.id] ?? ''} onChange={(e) => setNote({ ...note, [pr.id]: e.target.value })} />
                      <Button size="sm" variant="primary" onClick={() => decide(pr, 'accept')}><Check size={13} /> Übernehmen</Button>
                      <Button size="sm" onClick={() => decide(pr, 'reject')}><X size={13} /> Ablehnen</Button>
                      <Button size="sm" variant="ghost" onClick={() => edit(pr)} title="Als Szenario öffnen: anpassen, vergleichen, dann übernehmen"><FlaskConical size={13} /> Bearbeiten</Button>
                    </div>
                  )}
                </div>
              )}
              {pr.status !== 'open' && <div className="mt-2 text-xs text-ink-faint">Entschieden {pr.decided_at ? formatDateTime(pr.decided_at) : ''} von {org.userName(pr.decided_by)}{pr.decision_note ? ` – ${pr.decision_note}` : ''}</div>}
            </Card>
          )
        })}
      </div>
      <Modal open={dialog} onClose={() => setDialog(false)} title="Terminvorschlag erfassen" width="sm" footer={<><Button variant="ghost" onClick={() => setDialog(false)}>Abbrechen</Button><Button variant="primary" disabled={!form.task_id} onClick={create}>Erfassen</Button></>}>
        <div className="space-y-3">
          <Field label="Vorgang"><Select value={form.task_id} onChange={(e) => setForm({ ...form, task_id: e.target.value })}>{flattenTree(p.plan.tasks).filter((f) => !f.hasChildren).map((f) => <option key={f.task.id} value={f.task.id}>{f.task.name}</option>)}</Select></Field>
          <Field label="Vorgeschlagener Start"><Input type="date" value={form.proposed_start} onChange={(e) => setForm({ ...form, proposed_start: e.target.value })} /></Field>
          <Field label="Grund"><Select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>{Object.entries(DELAY_REASON_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Kommentar"><Textarea rows={2} value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  )
}
