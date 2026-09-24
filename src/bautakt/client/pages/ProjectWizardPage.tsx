/**
 * Projekt anlegen (intern): Art des Vorhabens (interne Aufgaben, Coaching, Software, frei),
 * Projektdaten, Zeitraum, Aufgabenquelle. Aufgabenquellen: Dokument (PDF/Word) per KI,
 * Lucidchart-Diagramm, interne Vorlage oder leerer Plan.
 */

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Check, Sparkles, LayoutTemplate, FileText, ListTree, Code2, GraduationCap, ClipboardList } from 'lucide-react'
import { api } from '../lib/api'
import { navigate, useRoute } from '../lib/router'
import { Button, Field, Input, PageHeader, Select } from '../components/ui'
import { useOrg } from '../store/org'
import { useToast } from '../store/toast'
import type { CreateProjectRequest, PlanningKind, ProjectTemplate } from '../../shared/types'
import { PLANNING_KIND_HINTS, PLANNING_KIND_LABELS } from '../../shared/labels'
import { addDays, todayISO } from '../../shared/engine/dates'
import { HOLIDAY_REGIONS } from '../../shared/engine/holidays'
import type { ExtractedPlan } from '../../shared/integrations/planextract/types'
import { PlanImportPanel } from '../components/PlanImportPanel'

const KIND_ICONS: Record<PlanningKind, React.ReactNode> = {
  internal: <ClipboardList size={20} />, coaching: <GraduationCap size={20} />, software: <Code2 size={20} />, free: <ListTree size={20} />,
  development: <ListTree size={20} />, construction: <ListTree size={20} />, process: <ListTree size={20} />,
}
const KINDS: PlanningKind[] = ['internal', 'coaching', 'software', 'free']

type StepId = 'kind' | 'data' | 'plan'
const STEP_LABELS: Record<StepId, string> = { kind: 'Art des Vorhabens', data: 'Projektdaten', plan: 'Aufgaben & Zeitplan' }

export function ProjectWizardPage() {
  const org = useOrg()
  const toast = useToast()
  const route = useRoute()
  const presetKind = (route.query.get('kind') as PlanningKind | null) ?? null
  const [step, setStep] = useState(presetKind && KINDS.includes(presetKind) ? 1 : 0)
  const [busy, setBusy] = useState(false)
  const [templates, setTemplates] = useState<(ProjectTemplate & { task_count: number })[]>([])
  const [importPlan, setImportPlan] = useState<ExtractedPlan | null>(null)
  const [importMode, setImportMode] = useState<'lucidchart' | 'document'>('document')
  const [form, setForm] = useState<CreateProjectRequest>({
    number: '', name: '', customer: '', address: '', city: '', project_manager_id: null, site_manager_id: null,
    planning_kind: presetKind && KINDS.includes(presetKind) ? presetKind : 'internal', holiday_region: org.org.holiday_region,
    project_type: 'individuell', construction_method: 'individuell', start_date: todayISO(), target_end_date: addDays(todayISO(), 60),
    area_sqm: null, floors: null, has_basement: false, plan_source: { kind: 'import', plan: { source: 'document', name: '', tasks: [] } },
  })
  const set = <K extends keyof CreateProjectRequest>(k: K, v: CreateProjectRequest[K]) => setForm((f) => ({ ...f, [k]: v }))
  const steps: StepId[] = ['kind', 'data', 'plan']
  const current = steps[Math.min(step, steps.length - 1)]

  useEffect(() => {
    api.templates.list().then(setTemplates).catch(() => {})
  }, [])
  useEffect(() => {
    if (org.org.holiday_region && !form.holiday_region) set('holiday_region', org.org.holiday_region)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org.org.holiday_region])

  const byKind = useMemo(() => templates.filter((t) => t.planning_kind === form.planning_kind), [templates, form.planning_kind])
  const internalTemplates = useMemo(
    () => templates.filter((t) => ['internal', 'coaching', 'software', 'free'].includes(t.planning_kind)),
    [templates],
  )

  const validStep = (id: StepId): boolean => {
    switch (id) {
      case 'kind': return true
      case 'data': return form.name.trim().length > 1 && form.start_date <= form.target_end_date
      case 'plan': return form.plan_source.kind === 'empty' || (form.plan_source.kind === 'template' && !!form.plan_source.template_id) || (form.plan_source.kind === 'import' && !!importPlan?.tasks.length)
    }
  }
  const allValid = steps.every(validStep)

  const submit = async () => {
    setBusy(true)
    try {
      const p = await api.projects.create(form)
      toast.push('Projekt angelegt.', 'success')
      navigate(`/projects/${p.id}/gantt`)
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const managers = org.members.filter((m) => ['owner', 'admin', 'management', 'project_manager'].includes(m.role))

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader title="Neues Projekt" subtitle={`In ${steps.length} Schritten zum Zeitplan`} breadcrumb={[{ label: 'Projekte', href: '/projects' }, { label: 'Neu' }]} />
      <ol className="mb-6 flex flex-wrap items-center gap-2 text-xs">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className={clsx('flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold', i < step ? 'bg-ok text-white' : i === step ? 'bg-brand text-white' : 'bg-surface-3 text-ink-faint')}>{i < step ? <Check size={12} /> : i + 1}</span>
            <span className={clsx(i === step ? 'font-medium text-ink' : 'text-ink-faint')}>{STEP_LABELS[s]}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-line" />}
          </li>
        ))}
      </ol>

      <div className="rounded-xl border border-line bg-surface p-5 shadow-sm">
        {current === 'kind' && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {KINDS.map((k) => (
                <OptionCard key={k} active={form.planning_kind === k} onClick={() => set('planning_kind', k)} icon={KIND_ICONS[k]} label={PLANNING_KIND_LABELS[k]} hint={PLANNING_KIND_HINTS[k]} />
              ))}
            </div>
            <p className="text-xs text-ink-faint">Die Terminberechnung (Abhängigkeiten, Arbeitstage, Feiertage, kritischer Pfad) ist für alle Arten identisch.</p>
          </div>
        )}
        {current === 'data' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required className="sm:col-span-2">
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={form.planning_kind === 'software' ? 'z. B. Kundenportal Version 2' : form.planning_kind === 'coaching' ? 'z. B. Coaching-Programm Frühjahr' : 'z. B. Angebotsprozess überarbeiten'} autoFocus />
            </Field>
            <Field label="Start" required><Input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} /></Field>
            <Field label="Ende" required hint={form.target_end_date < form.start_date ? 'Muss nach dem Start liegen' : undefined}><Input type="date" value={form.target_end_date} onChange={(e) => set('target_end_date', e.target.value)} /></Field>
            <Field label="Verantwortlicher" className="sm:col-span-2">
              <Select value={form.project_manager_id ?? ''} onChange={(e) => set('project_manager_id', e.target.value || null)}>
                <option value="">– auswählen –</option>
                {managers.map((m) => <option key={m.user_id} value={m.user_id}>{m.user?.name}</option>)}
              </Select>
            </Field>
          </div>
        )}
        {current === 'plan' && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <OptionCard active={form.plan_source.kind === 'import'} onClick={() => set('plan_source', { kind: 'import', plan: importPlan ?? { source: 'document', name: form.name || 'Importierter Plan', tasks: [] } })} icon={<Sparkles size={20} />} label="Aus Dokument oder Lucidchart" hint="PDF/Word per KI auswerten oder Diagramm laden" />
              <OptionCard active={form.plan_source.kind === 'template'} onClick={() => set('plan_source', { kind: 'template', template_id: byKind[0]?.id ?? internalTemplates[0]?.id ?? '' })} icon={<LayoutTemplate size={20} />} label="Interne Vorlage" hint="Aufgaben, Phasen, Abhängigkeiten" />
              <OptionCard active={form.plan_source.kind === 'empty'} onClick={() => set('plan_source', { kind: 'empty' })} icon={<FileText size={20} />} label="Leeren Plan erstellen" hint="Struktur selbst aufbauen" />
            </div>
            {form.plan_source.kind === 'template' && (
              <Field label="Vorlage">
                <Select value={form.plan_source.template_id} onChange={(e) => set('plan_source', { kind: 'template', template_id: e.target.value })}>
                  {byKind.length > 0 && (
                    <optgroup label={`Passend: ${PLANNING_KIND_LABELS[form.planning_kind]}`}>
                      {byKind.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.task_count} Aufgaben)</option>)}
                    </optgroup>
                  )}
                  <optgroup label="Alle internen Vorlagen">
                    {internalTemplates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.task_count} Aufgaben) · {PLANNING_KIND_LABELS[t.planning_kind]}</option>)}
                  </optgroup>
                </Select>
              </Field>
            )}
            {form.plan_source.kind === 'template' && form.plan_source.template_id && (
              <p className="text-sm text-ink-soft">{templates.find((t) => t.id === (form.plan_source as { template_id: string }).template_id)?.description}</p>
            )}
            {form.plan_source.kind === 'import' && (
              <PlanImportPanel
                plan={importPlan}
                onPlan={(p) => { setImportPlan(p); set('plan_source', { kind: 'import', plan: p ?? { source: 'document', name: form.name || 'Importierter Plan', tasks: [] } }) }}
              />
            )}
            <p className="text-xs text-ink-faint">Die Termine werden aus Start, Dauern, Abhängigkeiten und Feiertagen berechnet. Alles lässt sich danach im Zeitplan anpassen.</p>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <Button variant="ghost" onClick={() => (step === 0 ? navigate('/projects') : setStep(step - 1))}><ArrowLeft size={15} /> {step === 0 ? 'Abbrechen' : 'Zurück'}</Button>
        {step < steps.length - 1 ? (
          <Button variant="primary" disabled={!validStep(current)} onClick={() => setStep(step + 1)}>Weiter <ArrowRight size={15} /></Button>
        ) : (
          <Button variant="primary" disabled={!allValid} loading={busy} onClick={submit}><Check size={15} /> Projekt anlegen</Button>
        )}
      </div>
    </div>
  )
}

function OptionCard({ active, onClick, icon, label, hint, disabled }: { active: boolean; onClick: () => void; icon?: React.ReactNode; label: string; hint?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition',
        active ? 'border-brand bg-brand-soft/60 ring-2 ring-brand/30' : 'border-line bg-surface hover:border-line-strong',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {icon && <span className={active ? 'text-brand' : 'text-ink-faint'}>{icon}</span>}
      <span className="text-sm font-medium text-ink">{label}</span>
      {hint && <span className="text-xs text-ink-faint">{hint}</span>}
    </button>
  )
}
