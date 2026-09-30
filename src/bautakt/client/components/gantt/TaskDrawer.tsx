/**
 * Vorgangs-Drawer in drei UX-Tiefen: „Überblick“ (eine Aussage + Erklärung „Warum dieser
 * Termin?“ + Ausführungsbereitschaft), Bearbeiten (Termine, Abhängigkeiten in einfacher
 * Sprache, Voraussetzungen, Checkliste, Ressourcen) und „Profi“ (ES/EF/LS/LF/TF/FF,
 * Driving). Checkliste ist bewusst von Voraussetzungen getrennt: reine Büro-To-Dos ohne
 * Einfluss auf Ausführungsbereitschaft oder Terminberechnung.
 */

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { X, Trash2, Plus, Unlock, CheckCircle2, Circle, AlertTriangle, HelpCircle, ChevronRight, CalendarOff, Quote } from 'lucide-react'
import type { ConstraintKind, ConstraintStatus, ConstraintType, DependencyType, ResourceAssignment, Task, TaskChecklistItem, TaskConstraint, TaskStatus, TaskType } from '../../../shared/types'
import { useProject } from '../../store/project'
import { useOrg } from '../../store/org'
import { useToast } from '../../store/toast'
import { api } from '../../lib/api'
import { Button, Field, IconButton, Input, Select, Textarea, Badge, Delta, StatusBadge, Tabs } from '../ui'
import { TASK_STATUS_LABELS, TASK_TYPE_LABELS, CONSTRAINT_KIND_LABELS, CONSTRAINT_STATUS_LABELS } from '../../../shared/labels'
import { formatDate, toDayNumber } from '../../../shared/engine/dates'
import { flattenTree } from '../../../shared/engine/operations'
import { explainSpan } from '../../../shared/engine/calendar'

type Tab = 'overview' | 'edit' | 'deps' | 'ready' | 'checklist' | 'resources' | 'pro'

/** Einfache Abhängigkeits-Auswahl → FS/SS/FF */
const SIMPLE: { value: DependencyType; label: string; hint: string }[] = [
  { value: 'FS', label: 'Wenn diese Arbeit fertig ist', hint: 'Nachfolger beginnt nach dem Ende (FS)' },
  { value: 'SS', label: 'Wenn diese Arbeit beginnt', hint: 'Beide starten zusammen (SS)' },
  { value: 'FF', label: 'Beide sollen ungefähr gleichzeitig fertig werden', hint: 'Enden gemeinsam (FF)' },
]

export function TaskDrawer({ taskId, autoEdit, forceOverview, onClose }: { taskId: string; autoEdit?: boolean; forceOverview?: { taskId: string; nonce: number } | null; onClose: () => void }) {
  const p = useProject()
  const org = useOrg()
  const toast = useToast()
  const task = p.plan.tasks.find((t) => t.id === taskId)
  const sched = p.analysis?.current.tasks.get(taskId)
  const [tab, setTab] = useState<Tab>(autoEdit ? 'edit' : 'overview')
  const [name, setName] = useState(task?.name ?? '')
  const [notes, setNotes] = useState(task?.notes ?? '')
  const [newPred, setNewPred] = useState<{ id: string; type: DependencyType; lag: number; advanced: boolean }>({ id: '', type: 'FS', lag: 0, advanced: false })
  const [newConstraint, setNewConstraint] = useState<{ type: ConstraintKind; title: string }>({ type: 'material', title: '' })
  const [newChecklistText, setNewChecklistText] = useState('')
  useEffect(() => {
    setName(task?.name ?? '')
    setNotes(task?.notes ?? '')
  }, [taskId, task?.name, task?.notes])
  // Frisch angelegter Vorgang: gleich auf „Bearbeiten“ springen, damit man den Namen sofort
  // tippen oder reinsprechen kann, ohne erst den Tab zu wechseln.
  useEffect(() => {
    if (autoEdit) setTab('edit')
  }, [taskId, autoEdit])
  // Rechtsklick auf einen Vorgang: immer auf „Überblick“ springen - auch wenn der Drawer schon
  // auf einem anderen Tab offen war (Nonce, damit auch ein erneuter Rechtsklick greift).
  useEffect(() => {
    if (forceOverview) setTab('overview')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceOverview?.nonce])
  if (!task) return null
  const ro = !p.canEdit
  const hasChildren = p.plan.tasks.some((t) => t.parent_id === task.id)
  const isMs = task.type === 'milestone'
  const preds = p.plan.dependencies.filter((d) => d.successor_id === task.id)
  const succs = p.plan.dependencies.filter((d) => d.predecessor_id === task.id)
  const nameOf = (id: string) => p.plan.tasks.find((t) => t.id === id)?.name ?? '?'
  const candidates = flattenTree(p.plan.tasks).filter((f) => f.task.id !== task.id && !preds.some((d) => d.predecessor_id === f.task.id))
  const bl = p.analysis?.baselineTasks.get(task.id)
  const upd = (patch: Partial<Task>, reason?: string) => p.updateTask(task.id, patch, reason)
  const ex = p.explain(task.id)
  // Feiertage/arbeitsfreie Tage im Zeitraum des Vorgangs (Kalender des Vorgangs inkl. Firma/Kategorie/Region)
  const span = sched && !hasChildren && !isMs ? explainSpan(sched.calendar, sched.start, Math.max(1, sched.duration)) : null
  const readiness = p.readiness(task.id)
  const constraints = (p.bundle?.constraints ?? []).filter((c) => c.task_id === task.id)
  const checklist = (p.bundle?.checklist_items ?? []).filter((i) => i.task_id === task.id)
  const assignments = (p.bundle?.assignments ?? []).filter((a) => a.task_id === task.id)

  const saveConstraint = async () => {
    if (!newConstraint.title.trim()) return
    try {
      await api.constraints.create(p.projectId, { task_id: task.id, type: newConstraint.type, title: newConstraint.title.trim() })
      setNewConstraint({ type: 'material', title: '' })
      await p.reloadMeta()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const setConstraintStatus = async (c: TaskConstraint, status: ConstraintStatus) => {
    try {
      await api.constraints.update(p.projectId, c.id, { status })
      await p.reloadMeta()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const saveChecklistItem = async () => {
    if (!newChecklistText.trim()) return
    try {
      await api.checklist.create(p.projectId, { task_id: task.id, text: newChecklistText.trim() })
      setNewChecklistText('')
      await p.reloadMeta()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const toggleChecklistItem = async (item: TaskChecklistItem) => {
    try {
      await api.checklist.update(p.projectId, item.id, { done: !item.done })
      await p.reloadMeta()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const removeChecklistItem = async (id: string) => {
    try {
      await api.checklist.remove(p.projectId, id)
      await p.reloadMeta()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const saveAssignments = async (list: Partial<ResourceAssignment>[]) => {
    try {
      await api.assignments.set(p.projectId, task.id, list)
      await p.reloadMeta()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }

  return (
    <aside className="flex h-full w-full flex-col border-l border-line bg-surface">
      <header className="border-b border-line px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold tracking-wide text-ink-faint uppercase">{TASK_TYPE_LABELS[task.type]}{hasChildren && task.type !== 'phase' ? ' (Sammelvorgang)' : ''}{task.section_id ? ` · ${p.bundle?.sections.find((s) => s.id === task.section_id)?.name ?? ''}` : ''}</div>
            <div className="truncate text-sm font-semibold">{task.name}</div>
          </div>
          {sched?.isCritical && task.status !== 'done' && <Badge tone="danger">Terminentscheidend</Badge>}
          <IconButton title="Schließen" onClick={onClose}><X size={16} /></IconButton>
        </div>
        <Tabs className="mt-2" value={tab} onChange={setTab} items={[{ value: 'overview', label: 'Überblick' }, { value: 'edit', label: 'Bearbeiten' }, { value: 'deps', label: `Abhängigkeiten${preds.length ? ` (${preds.length})` : ''}` }, { value: 'ready', label: `Voraussetzungen${readiness?.openCount ? ` (${readiness.openCount})` : ''}` }, { value: 'checklist', label: `Checkliste${checklist.length ? ` (${checklist.filter((i) => !i.done).length}/${checklist.length})` : ''}` }, { value: 'resources', label: 'Ressourcen' }, { value: 'pro', label: 'Profi' }]} />
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {tab === 'overview' && ex && (
          <>
            {/* Level 1 */}
            <div className="rounded-xl border border-line bg-surface-2 p-4">
              <p className="text-[15px] font-semibold leading-snug">{ex.headline}</p>
              <p className={clsx('mt-1.5 text-sm', ex.isCritical ? 'text-danger' : 'text-ink-soft')}>{ex.floatSentence}</p>
              {!hasChildren && <div className="mt-2 flex items-center gap-2"><StatusBadge status={task.status} />{!isMs && <span className="text-xs text-ink-faint">{task.progress} % erledigt · Soll {sched?.plannedProgress ?? 0} %</span>}</div>}
            </div>
            {span && span.sentences.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn"><CalendarOff size={14} className="mt-0.5 shrink-0" /><div>{span.sentences.map((t, i) => <p key={i}>{t}</p>)}<p className="mt-0.5 text-[11px] opacity-80">Kalender: {sched?.calendar.name}</p></div></div>
            )}
            {task.source_excerpt && (
              <section>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-ink-faint uppercase"><Quote size={12} /> Herkunft (aus dem diktierten/eingegebenen Text)</h4>
                <blockquote className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-soft italic">„{task.source_excerpt}“</blockquote>
              </section>
            )}
            {/* Level 2 */}
            <section>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-ink-faint uppercase"><HelpCircle size={12} /> Warum dieser Termin?</h4>
              <ul className="space-y-1.5 text-sm">
                {ex.sentences.map((s, i) => <li key={i} className="flex gap-2"><ChevronRight size={14} className="mt-0.5 shrink-0 text-ink-faint" /><span>{s}</span></li>)}
                {ex.constraintSentence && <li className="flex gap-2"><ChevronRight size={14} className="mt-0.5 shrink-0 text-ink-faint" /><span>Einschränkung: {ex.constraintSentence}.</span></li>}
              </ul>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border border-line px-3 py-2 text-xs">
                <dt className="text-ink-faint">Frühester Start</dt><dd className="font-medium">{formatDate(ex.earliestStart)}</dd>
                <dt className="text-ink-faint">Spätester Start ohne Auswirkung</dt><dd className="font-medium">{formatDate(ex.latestStart)}</dd>
                <dt className="text-ink-faint">Spielraum</dt><dd className="font-medium">{task.status === 'done' ? '–' : ex.isCritical ? 'keiner' : `${ex.floatDays} Arbeitstage`}</dd>
              </dl>
              <p className="mt-2 text-sm text-ink-soft">{ex.affectedSentence}</p>
              {ex.successors.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">
                  {ex.successors.map((s) => <li key={s.id}>→ {s.name} {s.isCritical && <Badge tone="danger" className="ml-1">kritisch</Badge>}</li>)}
                </ul>
              )}
            </section>
            {readiness && !hasChildren && (
              <section>
                <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Ausführungsbereitschaft</h4>
                <ReadinessBadge readiness={readiness} />
                <ul className="mt-2 space-y-1 text-sm">{readiness.items.map((it) => <ReadinessRow key={it.id} item={it} />)}</ul>
                {readiness.items.length === 0 && <p className="text-xs text-ink-faint">Keine Voraussetzungen hinterlegt.</p>}
              </section>
            )}
            {bl && sched && (
              <section className="text-xs text-ink-soft">Baseline: {formatDate(bl.start_date)} – {formatDate(bl.end_date)} · Abweichung Ende <Delta days={sched.end - toDayNumber(bl.end_date)} suffix=" Tage" /></section>
            )}
          </>
        )}

        {tab === 'edit' && (
          <>
            <section className="space-y-3">
              <Field label="Bezeichnung"><Input value={name} disabled={ro} autoDictate={autoEdit ? taskId : false} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== task.name && upd({ name: name.trim() }, 'Umbenannt')} /></Field>
              {task.source_excerpt && (
                <div>
                  <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-ink-faint uppercase"><Quote size={12} /> Herkunft (aus dem diktierten/eingegebenen Text)</h4>
                  <blockquote className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-soft italic">„{task.source_excerpt}“</blockquote>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Typ"><Select value={task.type} disabled={ro || hasChildren} onChange={(e) => upd({ type: e.target.value as TaskType }, 'Typ geändert')}>{(Object.keys(TASK_TYPE_LABELS) as TaskType[]).map((t) => <option key={t} value={t}>{TASK_TYPE_LABELS[t]}</option>)}</Select></Field>
                <Field label="Status"><Select value={task.status} disabled={ro || hasChildren} onChange={(e) => upd({ status: e.target.value as TaskStatus }, 'Status geändert')}>{(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>)}</Select></Field>
                <Field label="Kategorie"><Select value={task.trade_id ?? ''} disabled={ro} onChange={(e) => upd({ trade_id: e.target.value || null })}><option value="">–</option>{org.trades.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
                <Field label="Firma"><Select value={task.company_id ?? ''} disabled={ro} onChange={(e) => upd({ company_id: e.target.value || null })}><option value="">–</option>{org.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
                <Field label="Verantwortliche" hint="Ein oder mehrere Teammitglieder wählen; zusätzlich kann ein Name frei eingetippt werden – steht klein unter dem Vorgang">
                  <div className="flex flex-wrap gap-1.5">
                    {org.members.map((m) => {
                      const cur = task.responsible_user_ids ?? []
                      const selected = cur.includes(m.user_id) || task.responsible_user_id === m.user_id
                      return (
                        <button key={m.user_id} type="button" disabled={ro}
                          onClick={() => {
                            const base = Array.from(new Set([...cur, ...(task.responsible_user_id ? [task.responsible_user_id] : [])]))
                            const next = selected ? base.filter((id) => id !== m.user_id) : [...base, m.user_id]
                            upd({ responsible_user_ids: next, responsible_user_id: null }, 'Verantwortliche geändert')
                          }}
                          className={clsx('rounded-full border px-2 py-0.5 text-xs transition-colors', selected ? 'border-brand bg-brand-soft font-medium text-brand' : 'border-line text-ink-soft hover:border-brand/50 disabled:opacity-60')}>
                          {m.user?.name ?? '–'}
                        </button>
                      )
                    })}
                  </div>
                  <Input defaultValue={task.responsible_name} disabled={ro} placeholder="Zusätzlich frei: z. B. Fa. Huber" key={task.id + task.responsible_name}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== task.responsible_name) upd({ responsible_name: v }, 'Verantwortlicher (frei) geändert') }} />
                </Field>
                <Field label="Abschnitt"><Select value={task.section_id ?? ''} disabled={ro} onChange={(e) => upd({ section_id: e.target.value || null })}><option value="">–</option>{(p.bundle?.sections ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
              </div>
            </section>
            <section>
              <h4 className="mb-2 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Termine</h4>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start"><Input type="date" value={task.start_date} disabled={ro || hasChildren} onChange={(e) => e.target.value && p.setStart(task.id, e.target.value)} /></Field>
                <Field label="Ende"><Input type="date" value={task.end_date} disabled={ro || hasChildren || isMs} onChange={(e) => e.target.value && p.setEnd(task.id, e.target.value)} /></Field>
                <Field label="Dauer (Arbeitstage)"><Input type="number" min={isMs ? 0 : 1} value={task.duration} disabled={ro || hasChildren || isMs} onChange={(e) => p.setDuration(task.id, Number(e.target.value))} /></Field>
                <Field label="Planung"><Select value={task.scheduling_mode} disabled={ro || hasChildren} onChange={(e) => (e.target.value === 'auto' ? p.releaseConstraint(task.id) : upd({ scheduling_mode: 'manual' }, 'Manuell geplant'))}><option value="auto">Automatisch (folgt Vorgängern)</option><option value="manual">Manuell (feste Termine)</option></Select></Field>
                <Field label="Einschränkung"><Select value={task.constraint_type} disabled={ro || hasChildren} onChange={(e) => upd({ constraint_type: e.target.value as ConstraintType, constraint_date: e.target.value === 'asap' ? null : task.constraint_date ?? task.start_date }, 'Einschränkung geändert')}><option value="asap">So früh wie möglich</option><option value="snet">Nicht früher als</option><option value="mso">Muss beginnen am</option><option value="fnlt">Nicht später enden als</option></Select></Field>
                <Field label="Datum der Einschränkung"><Input type="date" value={task.constraint_date ?? ''} disabled={ro || task.constraint_type === 'asap'} onChange={(e) => upd({ constraint_date: e.target.value || null }, 'Einschränkung geändert')} /></Field>
              </div>
              {!hasChildren && !isMs && (
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <Field label="Uhrzeit von"><Input type="time" value={task.start_time ?? ''} disabled={ro} onChange={(e) => upd({ start_time: e.target.value || null, ...(e.target.value ? {} : { end_time: null, duration_hours: null }) }, 'Uhrzeit geändert')} /></Field>
                  <Field label="Uhrzeit bis"><Input type="time" value={task.end_time ?? ''} disabled={ro || !task.start_time} onChange={(e) => upd({ end_time: e.target.value || null, duration_hours: null }, 'Uhrzeit geändert')} /></Field>
                  <Field label="Dauer (Stunden)"><Input type="number" step="0.25" min="0.25" value={task.duration_hours ?? ''} placeholder="ganztägig" disabled={ro || !task.start_time} onChange={(e) => upd({ duration_hours: e.target.value === '' ? null : Number(e.target.value), end_time: null }, 'Stunden geändert')} /></Field>
                </div>
              )}
              {!hasChildren && !isMs && <p className="mt-1 text-[11px] text-ink-faint">Ohne Uhrzeit gilt der Vorgang als ganztägig. Mit Uhrzeit lassen sich mehrere Vorgänge an einem Tag nacheinander planen.</p>}
              {(task.constraint_type !== 'asap' || task.scheduling_mode === 'manual') && !ro && <Button size="sm" variant="ghost" className="mt-2" onClick={() => p.releaseConstraint(task.id)}><Unlock size={13} /> Automatische Planung wiederherstellen</Button>}
              {sched?.hasConflict && <p className="mt-2 rounded-md bg-warn-soft px-2 py-1 text-xs text-warn">Abhängigkeit verletzt: Vorgänger enden nach dem geplanten Start.</p>}
              {span && span.sentences.length > 0 && <div className="mt-2 flex items-start gap-2 rounded-md bg-warn-soft px-2 py-1.5 text-xs text-warn"><CalendarOff size={13} className="mt-0.5 shrink-0" /><div>{span.sentences.map((t, i) => <p key={i}>{t}</p>)}</div></div>}
              {span && span.sentences.length === 0 && sched && <p className="mt-2 text-[11px] text-ink-faint">Keine Feiertage oder Schließtage im Zeitraum (Kalender: {sched.calendar.name}).</p>}
            </section>
            {!hasChildren && (
              <section>
                <h4 className="mb-2 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Fortschritt</h4>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={`Fortschritt: ${task.progress} %`}><input type="range" min={0} max={100} step={5} value={task.progress} disabled={ro || isMs} onChange={(e) => upd({ progress: Number(e.target.value) }, 'Fortschritt gemeldet')} className="w-full accent-brand" /></Field>
                  <Field label="Restdauer (AT)"><Input type="number" min={0} value={task.remaining_duration ?? ''} placeholder="automatisch" disabled={ro || isMs} onChange={(e) => upd({ remaining_duration: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
                  <Field label="Ist-Start"><Input type="date" value={task.actual_start ?? ''} disabled={ro} onChange={(e) => upd({ actual_start: e.target.value || null }, 'Ist-Start erfasst')} /></Field>
                  <Field label="Ist-Ende"><Input type="date" value={task.actual_finish ?? ''} disabled={ro || isMs} onChange={(e) => upd({ actual_finish: e.target.value || null }, 'Ist-Ende erfasst')} /></Field>
                </div>
              </section>
            )}
            <Field label="Notizen"><Textarea rows={9} value={notes} disabled={ro} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== task.notes && upd({ notes })} /></Field>
          </>
        )}

        {tab === 'deps' && (
          <>
            <section>
              <h4 className="mb-2 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Diese Arbeit darf beginnen, wenn …</h4>
              {preds.length === 0 && <p className="text-xs text-ink-faint">Kein Vorgänger – der Vorgang beginnt zum Projektstart oder zur Einschränkung.</p>}
              <ul className="space-y-1.5">
                {preds.map((d) => {
                  const driving = p.analysis?.current.drivingDependencyIds.has(d.id)
                  return (
                    <li key={d.id} className={clsx('rounded-md border px-2 py-1.5 text-xs', driving ? 'border-brand/40 bg-brand-soft/40' : 'border-line')}>
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium" title={nameOf(d.predecessor_id)}>{nameOf(d.predecessor_id)}</span>
                        {driving && <Badge tone="brand">bestimmt den Start</Badge>}
                        {!ro && <IconButton title="Entfernen" className="h-7 w-7" onClick={() => p.removeDependency(d.id)}><Trash2 size={13} /></IconButton>}
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <Select value={d.type} disabled={ro} className="h-7 flex-1 px-1 text-xs" onChange={(e) => p.updateDependency(d.id, { type: e.target.value as DependencyType })}>
                          {SIMPLE.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                          <option value="SF">Erweitert: Anfang → Ende (SF)</option>
                        </Select>
                        <span className="text-ink-faint">+</span>
                        <Input type="number" value={d.lag_days} disabled={ro} className="h-7 w-16 px-1 text-xs" title="Wartezeit / Vorlauf in Arbeitstagen" onChange={(e) => p.updateDependency(d.id, { lag_days: Number(e.target.value) || 0 })} />
                        <span className="text-ink-faint">AT</span>
                      </div>
                    </li>
                  )
                })}
              </ul>
              {!ro && (
                <div className="mt-3 space-y-2 rounded-lg border border-dashed border-line-strong p-2">
                  <Select value={newPred.id} className="h-8 text-xs" onChange={(e) => setNewPred({ ...newPred, id: e.target.value })}>
                    <option value="">Vorgänger hinzufügen …</option>
                    {candidates.map((c) => <option key={c.task.id} value={c.task.id}>{' '.repeat(c.depth * 2)}{c.task.name}</option>)}
                  </Select>
                  {newPred.id && (
                    <>
                      <div className="text-[11px] text-ink-faint">Wann darf „{task.name}“ beginnen?</div>
                      <div className="space-y-1">
                        {SIMPLE.map((s) => (
                          <label key={s.value} className={clsx('flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 text-xs', newPred.type === s.value ? 'border-brand bg-brand-soft/40' : 'border-line')}>
                            <input type="radio" name="deptype" className="mt-0.5 accent-brand" checked={newPred.type === s.value} onChange={() => setNewPred({ ...newPred, type: s.value })} />
                            <span><span className="font-medium">{s.label}</span><span className="block text-ink-faint">{s.hint}</span></span>
                          </label>
                        ))}
                        <button type="button" className="text-[11px] text-brand hover:underline" onClick={() => setNewPred({ ...newPred, advanced: !newPred.advanced })}>{newPred.advanced ? 'Einfache Auswahl' : 'Erweiterte Einstellung (SF, Vorlauf)'}</button>
                        {newPred.advanced && (
                          <div className="flex items-center gap-2 text-xs">
                            <Select value={newPred.type} className="h-7 w-16 px-1 text-xs" onChange={(e) => setNewPred({ ...newPred, type: e.target.value as DependencyType })}>{(['FS', 'SS', 'FF', 'SF'] as DependencyType[]).map((t) => <option key={t} value={t}>{t}</option>)}</Select>
                            <span>Lag/Lead</span>
                            <Input type="number" value={newPred.lag} className="h-7 w-16 px-1 text-xs" onChange={(e) => setNewPred({ ...newPred, lag: Number(e.target.value) || 0 })} />
                            <span className="text-ink-faint">AT (negativ = Vorlauf)</span>
                          </div>
                        )}
                        {!newPred.advanced && (
                          <div className="flex items-center gap-2 text-xs"><span>Wartezeit danach</span><Input type="number" min={0} value={newPred.lag} className="h-7 w-16 px-1 text-xs" onChange={(e) => setNewPred({ ...newPred, lag: Number(e.target.value) || 0 })} /><span className="text-ink-faint">Arbeitstage (z. B. Trocknung)</span></div>
                        )}
                      </div>
                      <Button size="sm" variant="primary" onClick={() => { if (!p.addDependency(newPred.id, task.id, newPred.type, newPred.lag)) setNewPred({ id: '', type: 'FS', lag: 0, advanced: false }) }}><Plus size={13} /> Verbinden</Button>
                    </>
                  )}
                </div>
              )}
            </section>
            <section>
              <h4 className="mb-2 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Danach betroffen</h4>
              {succs.length === 0 ? <p className="text-xs text-ink-faint">Kein Nachfolger.</p> : <ul className="space-y-1 text-xs">{succs.map((d) => <li key={d.id} className="flex items-center justify-between rounded-md border border-line px-2 py-1"><span>{nameOf(d.successor_id)}</span><span className="text-ink-faint">{d.type}{d.lag_days ? (d.lag_days > 0 ? '+' : '') + d.lag_days : ''}{p.analysis?.current.tasks.get(d.successor_id)?.isCritical ? ' · kritisch' : ''}</span></li>)}</ul>}
            </section>
          </>
        )}

        {tab === 'ready' && (
          <>
            {readiness && <ReadinessBadge readiness={readiness} />}
            <p className="text-xs text-ink-faint">Voraussetzungen verschieben keine Termine – sie zeigen, ob die Arbeit tatsächlich beginnen kann (Material, Freigaben, Planung, …).</p>
            <ul className="space-y-1.5">
              {constraints.map((c) => (
                <li key={c.id} className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-sm">
                  <button type="button" disabled={ro} title="Status wechseln" onClick={() => setConstraintStatus(c, c.status === 'fulfilled' ? 'open' : 'fulfilled')} className={clsx('shrink-0', c.status === 'fulfilled' ? 'text-ok' : c.status === 'blocked' ? 'text-warn' : 'text-ink-faint')}>
                    {c.status === 'fulfilled' ? <CheckCircle2 size={18} /> : c.status === 'blocked' ? <AlertTriangle size={18} /> : <Circle size={18} />}
                  </button>
                  <div className="min-w-0 flex-1"><div className={clsx('truncate', c.status === 'fulfilled' && 'text-ink-faint line-through')}>{c.title}</div><div className="text-[11px] text-ink-faint">{CONSTRAINT_KIND_LABELS[c.type]}{c.due_date ? ` · fällig ${formatDate(c.due_date)}` : ''}{c.note ? ` · ${c.note}` : ''}</div></div>
                  {!ro && <Select value={c.status} className="h-7 w-24 px-1 text-xs" onChange={(e) => setConstraintStatus(c, e.target.value as ConstraintStatus)}>{(Object.keys(CONSTRAINT_STATUS_LABELS) as ConstraintStatus[]).map((s) => <option key={s} value={s}>{CONSTRAINT_STATUS_LABELS[s]}</option>)}</Select>}
                  {!ro && <IconButton title="Entfernen" className="h-7 w-7" onClick={async () => { await api.constraints.remove(p.projectId, c.id); await p.reloadMeta() }}><Trash2 size={13} /></IconButton>}
                </li>
              ))}
              {readiness?.items.filter((i) => i.kind === 'predecessor').map((it) => <ReadinessRow key={it.id} item={it} />)}
            </ul>
            {!ro && (
              <div className="flex items-center gap-1.5">
                <Select value={newConstraint.type} className="h-8 w-32 text-xs" onChange={(e) => setNewConstraint({ ...newConstraint, type: e.target.value as ConstraintKind })}>{(Object.keys(CONSTRAINT_KIND_LABELS) as ConstraintKind[]).map((k) => <option key={k} value={k}>{CONSTRAINT_KIND_LABELS[k]}</option>)}</Select>
                <Input value={newConstraint.title} placeholder="z. B. Fliesen geliefert" className="h-8 text-xs" onChange={(e) => setNewConstraint({ ...newConstraint, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && saveConstraint()} />
                <Button size="sm" variant="primary" disabled={!newConstraint.title.trim()} onClick={saveConstraint}><Plus size={13} /></Button>
              </div>
            )}
          </>
        )}

        {tab === 'checklist' && (
          <>
            <p className="text-xs text-ink-faint">Einfache To-Dos zu diesem Vorgang (z. B. Briefing erstellen, Freigabe einholen). Rein informell - ohne eigenen Termin, ohne Einfluss auf Terminberechnung oder gemeldeten Fortschritt.</p>
            {checklist.length === 0 && <p className="text-xs text-ink-faint">Noch keine Checkliste angelegt.</p>}
            <ul className="space-y-1.5">
              {checklist.map((item) => (
                <li key={item.id} className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-sm">
                  <button type="button" disabled={ro} title="Erledigt umschalten" onClick={() => toggleChecklistItem(item)} className={clsx('shrink-0', item.done ? 'text-ok' : 'text-ink-faint')}>
                    {item.done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                  </button>
                  <div className={clsx('min-w-0 flex-1 truncate', item.done && 'text-ink-faint line-through')}>{item.text}</div>
                  {!ro && <IconButton title="Entfernen" className="h-7 w-7" onClick={() => removeChecklistItem(item.id)}><Trash2 size={13} /></IconButton>}
                </li>
              ))}
            </ul>
            {!ro && (
              <div className="flex items-center gap-1.5">
                <Input value={newChecklistText} placeholder="z. B. Briefing erstellen" className="h-8 text-xs" onChange={(e) => setNewChecklistText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveChecklistItem()} />
                <Button size="sm" variant="primary" disabled={!newChecklistText.trim()} onClick={saveChecklistItem}><Plus size={13} /></Button>
              </div>
            )}
          </>
        )}

        {tab === 'resources' && (
          <ResourcesTab task={task} assignments={assignments} readOnly={ro} onSave={saveAssignments} onDirect={(rid) => upd({ resource_id: rid })} />
        )}

        {tab === 'pro' && ex && sched && (
          <section>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-ink-faint">Early Start / Early Finish</dt><dd>{formatDate(ex.pro.es)} / {formatDate(ex.pro.ef)}</dd>
              <dt className="text-ink-faint">Late Start / Late Finish</dt><dd>{formatDate(ex.pro.ls)} / {formatDate(ex.pro.lf)}</dd>
              <dt className="text-ink-faint">Total Float (TF)</dt><dd>{ex.pro.tf} AT {ex.isCritical && <Badge tone="danger" className="ml-1">kritisch</Badge>}</dd>
              <dt className="text-ink-faint">Free Float (FF)</dt><dd>{ex.pro.ff} AT</dd>
              <dt className="text-ink-faint">Driving predecessor</dt><dd>{ex.pro.drivingPredecessor ? `${ex.pro.drivingPredecessor} (${ex.pro.drivingType})` : '–'}</dd>
              <dt className="text-ink-faint">Start bestimmt durch</dt><dd>{{ dependency: 'Abhängigkeit', constraint: 'Einschränkung', project_start: 'Projektstart', manual: 'manuelle Planung', actual: 'Ist-Start' }[ex.pro.startDriver]}</dd>
              <dt className="text-ink-faint">Kalender</dt><dd>{ex.pro.calendar}</dd>
              <dt className="text-ink-faint">Planungsmodus</dt><dd>{task.scheduling_mode === 'manual' ? 'manuell' : 'automatisch'} · {task.constraint_type.toUpperCase()}{task.constraint_date ? ` ${formatDate(task.constraint_date)}` : ''}</dd>
              <dt className="text-ink-faint">Ist-Dauer</dt><dd>{task.actual_duration !== null ? `${task.actual_duration} AT (Plan ${task.duration} AT)` : '–'}</dd>
              {bl && <><dt className="text-ink-faint">Baseline</dt><dd>{formatDate(bl.start_date)} – {formatDate(bl.end_date)} ({bl.duration} AT), Abw. <Delta days={sched.end - toDayNumber(bl.end_date)} suffix=" T" /></dd></>}
            </dl>
            <h4 className="mt-4 mb-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Vorgänger (Profi)</h4>
            <table className="w-full text-xs"><thead><tr className="text-left text-ink-faint"><th className="py-1 font-medium">Vorgänger</th><th className="font-medium">Typ</th><th className="font-medium">Ende/Start</th><th className="font-medium">Treibend</th></tr></thead>
              <tbody>{ex.drivers.map((d) => <tr key={d.dependencyId} className="border-t border-line"><td className="py-1">{d.predecessorName}</td><td>{d.type}{d.lag ? (d.lag > 0 ? '+' : '') + d.lag : ''}</td><td>{formatDate(d.type === 'SS' || d.type === 'SF' ? d.predecessorStart : d.predecessorEnd, 'short')}</td><td>{d.isDriving ? '●' : ''}</td></tr>)}</tbody></table>
          </section>
        )}
      </div>
      {!ro && (
        <footer className="flex items-center justify-between border-t border-line px-4 py-2.5">
          <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-soft" onClick={() => { if (confirm(`„${task.name}“${hasChildren ? ' inkl. aller Untervorgänge' : ''} löschen?`)) { p.deleteTasks([task.id]); onClose() } }}><Trash2 size={13} /> Löschen</Button>
          <span className="text-xs text-ink-faint">{p.saving ? 'Speichert …' : p.dirty ? 'Ungespeichert' : 'Gespeichert'}</span>
        </footer>
      )}
    </aside>
  )
}

function ReadinessBadge({ readiness }: { readiness: NonNullable<ReturnType<ReturnType<typeof useProject>['readiness']>> }) {
  const tone = readiness.status === 'ready' || readiness.status === 'done' ? 'ok' : readiness.status === 'in_progress' ? 'brand' : 'warn'
  return <Badge tone={tone} dot>{readiness.label}{readiness.openCount ? ` · ${readiness.openCount} offen` : ''}</Badge>
}

function ReadinessRow({ item }: { item: { label: string; detail: string; state: 'ok' | 'warn' | 'open'; kind: string } }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {item.state === 'ok' ? <CheckCircle2 size={16} className="shrink-0 text-ok" /> : item.state === 'warn' ? <AlertTriangle size={16} className="shrink-0 text-warn" /> : <Circle size={16} className="shrink-0 text-ink-faint" />}
      <span className={clsx('min-w-0 flex-1 truncate', item.state === 'ok' && 'text-ink-soft')}>{item.label}</span>
      <span className="text-[11px] text-ink-faint">{item.kind === 'predecessor' ? 'Vorleistung · ' : ''}{item.detail}</span>
    </li>
  )
}

function ResourcesTab({ task, assignments, readOnly, onSave, onDirect }: { task: Task; assignments: ResourceAssignment[]; readOnly: boolean; onSave: (list: Partial<ResourceAssignment>[]) => Promise<void>; onDirect: (rid: string | null) => void }) {
  const org = useOrg()
  const [list, setList] = useState<Partial<ResourceAssignment>[]>(assignments)
  useEffect(() => setList(assignments), [assignments])
  const [add, setAdd] = useState('')
  return (
    <div className="space-y-4">
      <Field label="Hauptressource (Team)" hint="Wird für Überschneidungen über Projekte hinweg geprüft">
        <Select value={task.resource_id ?? ''} disabled={readOnly} onChange={(e) => onDirect(e.target.value || null)}><option value="">–</option>{org.resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
      </Field>
      <section>
        <h4 className="mb-2 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Weitere Zuweisungen (Einheiten, optional Zeitraum)</h4>
        <ul className="space-y-1.5">
          {list.map((a, i) => (
            <li key={a.id ?? i} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium">{org.resourceName(a.resource_id ?? null)}</span>
              <Input type="number" min={0.5} step={0.5} value={a.units ?? 1} disabled={readOnly} className="h-7 w-14 px-1 text-xs" title="Einheiten / Kapazität" onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, units: Number(e.target.value) || 1 } : x)))} />
              <Input type="date" value={a.start_date ?? ''} disabled={readOnly} className="h-7 w-32 px-1 text-xs" onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, start_date: e.target.value || null } : x)))} />
              <Input type="date" value={a.end_date ?? ''} disabled={readOnly} className="h-7 w-32 px-1 text-xs" onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, end_date: e.target.value || null } : x)))} />
              {!readOnly && <IconButton title="Entfernen" className="h-7 w-7" onClick={() => setList(list.filter((_, j) => j !== i))}><Trash2 size={13} /></IconButton>}
            </li>
          ))}
          {list.length === 0 && <li className="text-xs text-ink-faint">Keine weiteren Zuweisungen.</li>}
        </ul>
        {!readOnly && (
          <div className="mt-2 flex items-center gap-1.5">
            <Select value={add} className="h-8 text-xs" onChange={(e) => setAdd(e.target.value)}><option value="">Ressource hinzufügen …</option>{org.resources.filter((r) => !list.some((a) => a.resource_id === r.id)).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.type === 'team' ? 'Team' : r.type === 'person' ? 'Person' : 'Gerät'})</option>)}</Select>
            <Button size="sm" disabled={!add} onClick={() => { setList([...list, { resource_id: add, units: 1, start_date: null, end_date: null }]); setAdd('') }}><Plus size={13} /></Button>
            <Button size="sm" variant="primary" onClick={() => onSave(list)}>Speichern</Button>
          </div>
        )}
      </section>
    </div>
  )
}
