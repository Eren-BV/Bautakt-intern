/**
 * Projekt anlegen. Erster Schritt: Art der Planung (frei, Projektentwicklung, Bauausführung,
 * prozessbasiert). Nur die Bauausführung fragt Projektart/Bauweise/Rahmendaten ab; alle
 * anderen kommen mit Projektdaten → Zeitraum → Planquelle aus. Planquelle: leer, Vorlage,
 * BuildFlow-Prozess (JSON-Export) oder (vorbereitet, deaktiviert) KI.
 */

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Check, Sparkles, LayoutTemplate, FileText, Home, Building, Building2, Warehouse, Hammer, Bath, Wrench, Boxes, ListTree, HardHat, Workflow, Compass, Upload } from 'lucide-react'
import { api } from '../lib/api'
import { navigate, useRoute } from '../lib/router'
import { Button, Checkbox, Field, Input, PageHeader, Select, Textarea } from '../components/ui'
import { useOrg } from '../store/org'
import { useToast } from '../store/toast'
import type { ConstructionMethod, CreateProjectRequest, PlanningKind, ProjectTemplate, ProjectType } from '../../shared/types'
import { CONSTRUCTION_LABELS, PLANNING_KIND_HINTS, PLANNING_KIND_LABELS, PROJECT_TYPE_LABELS } from '../../shared/labels'
import { addDays, todayISO } from '../../shared/engine/dates'
import { HOLIDAY_REGIONS } from '../../shared/engine/holidays'
import { parseBuildFlowExport, type BuildFlowProcess } from '../../shared/integrations/buildflow/types'
import { mapProcessToTemplate } from '../../shared/integrations/buildflow/adapter'
import type { ExtractedPlan } from '../../shared/integrations/planextract/types'
import { PlanImportPanel } from '../components/PlanImportPanel'

const TYPE_ICONS: Record<ProjectType, React.ReactNode> = {
  efh: <Home size={20} />, dhh: <Building size={20} />, mfh: <Building2 size={20} />, gewerbe: <Warehouse size={20} />,
  wohnung_sanierung: <Hammer size={20} />, haus_sanierung: <Wrench size={20} />, bad_sanierung: <Bath size={20} />, individuell: <Boxes size={20} />,
}
const KIND_ICONS: Record<PlanningKind, React.ReactNode> = { free: <ListTree size={20} />, development: <Compass size={20} />, construction: <HardHat size={20} />, process: <Workflow size={20} /> }
const KINDS: PlanningKind[] = ['construction', 'development', 'free', 'process']

type StepId = 'kind' | 'data' | 'type' | 'method' | 'frame' | 'dates' | 'plan'
const STEP_LABELS: Record<StepId, string> = { kind: 'Art der Planung', data: 'Projektdaten', type: 'Projektart', method: 'Bauweise', frame: 'Rahmendaten', dates: 'Zeitraum', plan: 'Terminplan' }

export function ProjectWizardPage() {
  const org = useOrg()
  const toast = useToast()
  const route = useRoute()
  const presetKind = (route.query.get('kind') as PlanningKind | null) ?? null
  const [step, setStep] = useState(presetKind && KINDS.includes(presetKind) ? 1 : 0)
  const [busy, setBusy] = useState(false)
  const [templates, setTemplates] = useState<(ProjectTemplate & { task_count: number })[]>([])
  const [processText, setProcessText] = useState('')
  const [processes, setProcesses] = useState<BuildFlowProcess[]>([])
  const [importPlan, setImportPlan] = useState<ExtractedPlan | null>(null)
  const [form, setForm] = useState<CreateProjectRequest>({
    number: '', name: '', customer: '', address: '', city: '', project_manager_id: null, site_manager_id: null,
    planning_kind: presetKind && KINDS.includes(presetKind) ? presetKind : 'construction', holiday_region: org.org.holiday_region,
    project_type: 'efh', construction_method: 'massiv', start_date: addDays(todayISO(), 14), target_end_date: addDays(todayISO(), 14 + 270),
    area_sqm: null, floors: 2, has_basement: false, plan_source: { kind: 'template', template_id: '' },
  })
  const set = <K extends keyof CreateProjectRequest>(k: K, v: CreateProjectRequest[K]) => setForm((f) => ({ ...f, [k]: v }))
  const isConstruction = form.planning_kind === 'construction'
  const steps: StepId[] = isConstruction ? ['kind', 'data', 'type', 'method', 'frame', 'plan'] : ['kind', 'data', 'dates', 'plan']
  const current = steps[Math.min(step, steps.length - 1)]

  useEffect(() => {
    api.templates.list().then(setTemplates).catch(() => {})
  }, [])
  useEffect(() => {
    if (org.org.holiday_region && !form.holiday_region) set('holiday_region', org.org.holiday_region)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org.org.holiday_region])

  // Passende Vorlagen: nach Planungsart, bei Bauausführung zusätzlich nach Projektart & Bauweise
  const byKind = useMemo(() => templates.filter((t) => t.planning_kind === form.planning_kind), [templates, form.planning_kind])
  const suggested = useMemo(
    () => (isConstruction ? byKind.filter((t) => t.project_type === form.project_type && (t.construction_method === form.construction_method || t.construction_method === 'individuell')) : byKind),
    [byKind, isConstruction, form.project_type, form.construction_method],
  )
  useEffect(() => {
    if (form.plan_source.kind === 'template' && !form.plan_source.template_id && (suggested[0] ?? byKind[0])) set('plan_source', { kind: 'template', template_id: (suggested[0] ?? byKind[0]).id })
  }, [suggested, byKind, form.plan_source])
  useEffect(() => {
    // Planungsart wechseln → Planquelle zurücksetzen
    if (form.planning_kind === 'process') set('plan_source', { kind: 'buildflow', process: null })
    else if (form.plan_source.kind === 'buildflow') set('plan_source', { kind: 'template', template_id: '' })
    if (form.planning_kind !== 'construction') { set('project_type', 'individuell'); set('construction_method', 'individuell') }
    else if (form.project_type === 'individuell' && form.construction_method === 'individuell') { set('project_type', 'efh'); set('construction_method', 'massiv') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.planning_kind])

  const onProcessText = (text: string) => {
    setProcessText(text)
    try {
      const list = text.trim() ? parseBuildFlowExport(JSON.parse(text)) : []
      setProcesses(list)
      set('plan_source', { kind: 'buildflow', process: list.length ? list : null })
    } catch {
      setProcesses([])
      set('plan_source', { kind: 'buildflow', process: null })
    }
  }
  const loadSample = async () => {
    const s = await api.buildflow.sample()
    onProcessText(JSON.stringify([s.current], null, 2))
  }
  const processPreview = useMemo(() => processes.map((p) => ({ name: p.name, tasks: mapProcessToTemplate(p).tasks })), [processes])

  const validStep = (id: StepId): boolean => {
    switch (id) {
      case 'kind': return true
      case 'data': return form.name.trim().length > 1
      case 'type': case 'method': return true
      case 'frame': case 'dates': return form.start_date <= form.target_end_date
      case 'plan': return form.plan_source.kind === 'empty' || (form.plan_source.kind === 'template' && !!form.plan_source.template_id) || (form.plan_source.kind === 'buildflow' && !!form.plan_source.process) || (form.plan_source.kind === 'import' && !!importPlan?.tasks.length)
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
  const siteManagers = org.members.filter((m) => ['owner', 'admin', 'project_manager', 'site_manager'].includes(m.role))
  const planLabel = isConstruction ? 'Bauzeitenplan' : 'Terminplan'

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader title="Neues Projekt" subtitle={`In ${steps.length} Schritten zum ${planLabel}`} breadcrumb={[{ label: 'Projekte', href: '/projects' }, { label: 'Neu' }]} />
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
            <p className="text-xs text-ink-faint">Die Terminberechnung (Abhängigkeiten, Kalender, Feiertage, kritischer Pfad, Szenarien) ist für alle Arten identisch – nur die baubezogenen Felder unterscheiden sich.</p>
          </div>
        )}
        {current === 'data' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Projektname" required className="sm:col-span-2"><Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={isConstruction ? 'z. B. Doppelhaushälfte Musterstraße' : form.planning_kind === 'development' ? 'z. B. Neubauprojekt Am Sonnenhang – Vorbereitung' : 'z. B. Angebotsprozess Gartenstadt'} autoFocus /></Field>
            <Field label="Projektnummer"><Input value={form.number} onChange={(e) => set('number', e.target.value)} placeholder="BV-2026-012" /></Field>
            <Field label={isConstruction ? 'Kunde / Bauherr' : 'Auftraggeber / Kunde'}><Input value={form.customer} onChange={(e) => set('customer', e.target.value)} /></Field>
            <Field label="Adresse"><Input value={form.address} onChange={(e) => set('address', e.target.value)} placeholder="Straße Hausnummer" /></Field>
            <Field label="PLZ Ort"><Input value={form.city} onChange={(e) => set('city', e.target.value)} /></Field>
            <Field label="Projektleiter">
              <Select value={form.project_manager_id ?? ''} onChange={(e) => set('project_manager_id', e.target.value || null)}>
                <option value="">– auswählen –</option>
                {managers.map((m) => <option key={m.user_id} value={m.user_id}>{m.user?.name}</option>)}
              </Select>
            </Field>
            {isConstruction && (
              <Field label="Bauleiter">
                <Select value={form.site_manager_id ?? ''} onChange={(e) => set('site_manager_id', e.target.value || null)}>
                  <option value="">– auswählen –</option>
                  {siteManagers.map((m) => <option key={m.user_id} value={m.user_id}>{m.user?.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Feiertagsregion" hint="Gesetzliche Feiertage fließen als arbeitsfreie Tage in jede Terminberechnung ein" className={isConstruction ? '' : 'sm:col-span-1'}>
              <Select value={form.holiday_region ?? org.org.holiday_region} onChange={(e) => set('holiday_region', e.target.value)}>
                {HOLIDAY_REGIONS.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
              </Select>
            </Field>
          </div>
        )}
        {current === 'type' && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(Object.keys(PROJECT_TYPE_LABELS) as ProjectType[]).map((t) => (
              <OptionCard key={t} active={form.project_type === t} onClick={() => set('project_type', t)} icon={TYPE_ICONS[t]} label={PROJECT_TYPE_LABELS[t]} />
            ))}
          </div>
        )}
        {current === 'method' && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(Object.keys(CONSTRUCTION_LABELS) as ConstructionMethod[]).map((m) => (
              <OptionCard key={m} active={form.construction_method === m} onClick={() => set('construction_method', m)} label={CONSTRUCTION_LABELS[m]} />
            ))}
          </div>
        )}
        {(current === 'frame' || current === 'dates') && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={isConstruction ? 'Baustart' : 'Projektstart'} required><Input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} /></Field>
            <Field label={isConstruction ? 'Gewünschte Fertigstellung' : 'Zieltermin'} required hint={form.target_end_date < form.start_date ? 'Muss nach dem Start liegen' : undefined}><Input type="date" value={form.target_end_date} onChange={(e) => set('target_end_date', e.target.value)} /></Field>
            {isConstruction && (<>
              <Field label="Wohn-/Nutzfläche (m²)"><Input type="number" min={0} value={form.area_sqm ?? ''} onChange={(e) => set('area_sqm', e.target.value ? Number(e.target.value) : null)} /></Field>
              <Field label="Anzahl Geschosse"><Input type="number" min={1} max={20} value={form.floors ?? ''} onChange={(e) => set('floors', e.target.value ? Number(e.target.value) : null)} /></Field>
              <Checkbox label="Keller vorhanden" checked={form.has_basement} onChange={(e) => set('has_basement', e.target.checked)} />
            </>)}
          </div>
        )}
        {current === 'plan' && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <OptionCard active={form.plan_source.kind === 'empty'} onClick={() => set('plan_source', { kind: 'empty' })} icon={<FileText size={20} />} label={`Leeren ${planLabel} erstellen`} hint="Struktur selbst aufbauen" />
              <OptionCard active={form.plan_source.kind === 'template'} onClick={() => set('plan_source', { kind: 'template', template_id: suggested[0]?.id ?? byKind[0]?.id ?? templates[0]?.id ?? '' })} icon={<LayoutTemplate size={20} />} label="Vorlage verwenden" hint="Phasen, Vorgänge, Abhängigkeiten" />
              <OptionCard active={form.plan_source.kind === 'buildflow'} onClick={() => set('plan_source', { kind: 'buildflow', process: processes.length ? processes : null })} icon={<Workflow size={20} />} label="Aus BuildFlow-Prozess" hint="JSON-Export übernehmen" />
              <OptionCard active={form.plan_source.kind === 'import'} onClick={() => set('plan_source', { kind: 'import', plan: importPlan ?? { source: 'lucidchart', name: form.name || 'Importierter Plan', tasks: [] } })} icon={<Sparkles size={20} />} label="Aus Lucidchart oder Dokument" hint="Diagramm laden oder PDF/Word per KI auswerten" />
            </div>
            {form.plan_source.kind === 'template' && (
              <Field label="Vorlage">
                <Select value={form.plan_source.template_id} onChange={(e) => set('plan_source', { kind: 'template', template_id: e.target.value })}>
                  {suggested.length > 0 && (
                    <optgroup label={isConstruction ? 'Passend zu Projektart & Bauweise' : `Passend: ${PLANNING_KIND_LABELS[form.planning_kind]}`}>
                      {suggested.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.task_count} Vorgänge)</option>)}
                    </optgroup>
                  )}
                  <optgroup label="Alle Vorlagen">
                    {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.task_count} Vorgänge) · {PLANNING_KIND_LABELS[t.planning_kind]}</option>)}
                  </optgroup>
                </Select>
              </Field>
            )}
            {form.plan_source.kind === 'template' && form.plan_source.template_id && (
              <p className="text-sm text-ink-soft">{templates.find((t) => t.id === (form.plan_source as { template_id: string }).template_id)?.description}</p>
            )}
            {form.plan_source.kind === 'buildflow' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2"><Upload size={15} /> prozesse.json wählen<input type="file" accept=".json,application/json" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) onProcessText(await f.text()) }} /></label>
                  <span className="text-xs text-ink-faint">oder einfügen:</span>
                  <Button size="sm" variant="ghost" onClick={loadSample}>Beispiel laden</Button>
                </div>
                <Textarea rows={4} value={processText} onChange={(e) => onProcessText(e.target.value)} placeholder='BuildFlow → Prozesse → „Exportieren“ → Inhalt der prozesse.json hier einfügen' className="font-mono text-xs" />
                {processText && processes.length === 0 && <p className="text-xs text-danger">Kein gültiger BuildFlow-Prozess erkannt (erwartet: Objekt/Array mit id, name, nodes, edges).</p>}
                {processPreview.map((p) => (
                  <div key={p.name} className="rounded-lg border border-line bg-surface-2 p-3 text-xs">
                    <div className="mb-1 font-semibold">{p.name} → {p.tasks.filter((t) => t.type === 'task').length} Vorgänge, {p.tasks.filter((t) => t.type === 'milestone').length} Meilensteine, {p.tasks.filter((t) => t.type === 'group').length} Bereiche</div>
                    <div className="text-ink-soft">Prozess → Phase · Bereich → Gruppe · Schritt → Vorgang · Entscheidung/Ende → Meilenstein · Verbindung → Abhängigkeit · Wartepunkt → Lag bzw. Voraussetzung · Rolle → Notiz · Frist → Einschränkung</div>
                  </div>
                ))}
              </div>
            )}
            {form.plan_source.kind === 'import' && (
              <PlanImportPanel
                plan={importPlan}
                onPlan={(p) => { setImportPlan(p); set('plan_source', { kind: 'import', plan: p ?? { source: 'lucidchart', name: form.name || 'Importierter Plan', tasks: [] } }) }}
              />
            )}
            <p className="text-xs text-ink-faint">Die Termine werden aus Start, Dauern, Abhängigkeiten, Arbeitskalender und Feiertagen der Region berechnet. Sie können danach alles im Terminplan anpassen.</p>
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
