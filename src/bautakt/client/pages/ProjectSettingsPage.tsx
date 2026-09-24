/**
 * Projektdaten bearbeiten (Planungsart, Feiertagsregion, Projektkalender, Status), bau-
 * bezogene Felder nur bei Bauausführung, Bauabschnitte, BuildFlow-Verknüpfung, baulogische
 * Regeln des Projekts, Import, als Vorlage speichern, Projekt löschen.
 */

import { useEffect, useState } from 'react'
import { Save, LayoutTemplate, Trash2, Plus, Upload, FolderPlus } from 'lucide-react'
import { ImportDialog } from '../components/ImportDialog'
import { BuildFlowPanel } from '../components/BuildFlowPanel'
import { RulesPanel } from '../components/RulesPanel'
import { HOLIDAY_REGIONS, holidaysFor } from '../../shared/engine/holidays'
import { formatDate } from '../../shared/engine/dates'
import { useProject } from '../store/project'
import { useOrg } from '../store/org'
import { useAuth } from '../store/auth'
import { useToast } from '../store/toast'
import { api } from '../lib/api'
import { navigate } from '../lib/router'
import { ProjectHeader } from '../components/ProjectHeader'
import { Button, Card, Checkbox, Field, Input, Modal, Select, Spinner } from '../components/ui'
import type { ConstructionMethod, PlanningKind, Project, ProjectState, ProjectType } from '../../shared/types'
import { CONSTRUCTION_LABELS, PLANNING_KIND_LABELS, PROJECT_STATE_LABELS, PROJECT_TYPE_LABELS } from '../../shared/labels'

export function ProjectSettingsPage() {
  const p = useProject()
  const org = useOrg()
  const { can } = useAuth()
  const toast = useToast()
  const [form, setForm] = useState<Partial<Project>>({})
  const [busy, setBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [newSection, setNewSection] = useState('')
  const [shiftDialog, setShiftDialog] = useState<{ from: string; to: string; shift: boolean } | null>(null)
  const [copyDialog, setCopyDialog] = useState<{ name: string; number: string; start: string } | null>(null)
  useEffect(() => {
    if (p.bundle) setForm({ ...p.bundle.project })
  }, [p.bundle])
  if (!p.bundle) return <Spinner />
  const set = <K extends keyof Project>(k: K, v: Project[K]) => setForm((f) => ({ ...f, [k]: v }))
  const ro = !can('project.edit')
  const construction = (form.planning_kind ?? p.bundle.project.planning_kind) === 'construction'
  const region = form.holiday_region ?? p.bundle.project.holiday_region
  const year = new Date(form.start_date ?? p.bundle.project.start_date).getFullYear()

  const save = async (shiftTasks?: boolean) => {
    // Startdatum geändert → erst fragen, ob die Vorgänge mitwandern sollen
    if (shiftTasks === undefined && form.start_date && form.start_date !== p.bundle!.project.start_date) {
      setShiftDialog({ from: p.bundle!.project.start_date, to: form.start_date, shift: true })
      return
    }
    setBusy(true)
    try {
      await p.updateProject({ ...form, ...(shiftTasks !== undefined ? { shift_tasks: shiftTasks } : {}) } as Partial<Project>)
      setShiftDialog(null)
      toast.push(shiftTasks ? 'Projektstart verschoben – Vorgänge wurden mitgenommen.' : 'Projektdaten gespeichert.', 'success')
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const asTemplate = async () => {
    const name = prompt('Name der Vorlage:', `${p.bundle!.project.name} (Vorlage)`)
    if (!name) return
    try {
      await api.templates.create({ name, from_project_id: p.projectId })
      toast.push('Vorlage erstellt.', 'success')
      navigate('/templates')
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const remove = async () => {
    if (!confirm(`Projekt „${p.bundle!.project.name}“ unwiderruflich löschen?`)) return
    await api.projects.remove(p.projectId)
    navigate('/projects')
  }

  return (
    <div>
      <ProjectHeader title="Projektdaten" />
      <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
        <Card title="Stammdaten">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Projektname" className="sm:col-span-2"><Input value={form.name ?? ''} disabled={ro} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Projektnummer"><Input value={form.number ?? ''} disabled={ro} onChange={(e) => set('number', e.target.value)} /></Field>
            <Field label="Kunde"><Input value={form.customer ?? ''} disabled={ro} onChange={(e) => set('customer', e.target.value)} /></Field>
            <Field label="Adresse"><Input value={form.address ?? ''} disabled={ro} onChange={(e) => set('address', e.target.value)} /></Field>
            <Field label="PLZ Ort"><Input value={form.city ?? ''} disabled={ro} onChange={(e) => set('city', e.target.value)} /></Field>
            <Field label="Art der Planung" hint="Die Terminberechnung ist für alle Arten identisch; baubezogene Felder gelten nur für die Bauausführung"><Select value={form.planning_kind ?? 'construction'} disabled={ro} onChange={(e) => set('planning_kind', e.target.value as PlanningKind)}>{(Object.keys(PLANNING_KIND_LABELS) as PlanningKind[]).map((k) => <option key={k} value={k}>{PLANNING_KIND_LABELS[k]}</option>)}</Select></Field>
            <Field label="Feiertagsregion" hint={`Feiertage ${year}: ${holidaysFor(year, region).slice(0, 4).map((h) => `${formatDate(h.date, 'short')} ${h.name}`).join(', ')} …`}><Select value={region} disabled={ro} onChange={(e) => set('holiday_region', e.target.value)}>{HOLIDAY_REGIONS.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</Select></Field>
            {construction && <Field label="Projektart"><Select value={form.project_type ?? 'individuell'} disabled={ro} onChange={(e) => set('project_type', e.target.value as ProjectType)}>{(Object.keys(PROJECT_TYPE_LABELS) as ProjectType[]).map((t) => <option key={t} value={t}>{PROJECT_TYPE_LABELS[t]}</option>)}</Select></Field>}
            {construction && <Field label="Bauweise"><Select value={form.construction_method ?? 'individuell'} disabled={ro} onChange={(e) => set('construction_method', e.target.value as ConstructionMethod)}>{(Object.keys(CONSTRUCTION_LABELS) as ConstructionMethod[]).map((t) => <option key={t} value={t}>{CONSTRUCTION_LABELS[t]}</option>)}</Select></Field>}
            <Field label="Projektleiter"><Select value={form.project_manager_id ?? ''} disabled={ro} onChange={(e) => set('project_manager_id', e.target.value || null)}><option value="">–</option>{org.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.user?.name}</option>)}</Select></Field>
            {construction && <Field label="Bauleiter"><Select value={form.site_manager_id ?? ''} disabled={ro} onChange={(e) => set('site_manager_id', e.target.value || null)}><option value="">–</option>{org.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.user?.name}</option>)}</Select></Field>}
          </div>
        </Card>
        <Card title="Rahmendaten & Planung">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={construction ? 'Baustart' : 'Projektstart'} hint="Verschiebt automatisch geplante Vorgänge ohne Einschränkung"><Input type="date" value={form.start_date ?? ''} disabled={ro} onChange={(e) => set('start_date', e.target.value)} /></Field>
            <Field label={construction ? 'Gewünschte Fertigstellung' : 'Zieltermin'}><Input type="date" value={form.target_end_date ?? ''} disabled={ro} onChange={(e) => set('target_end_date', e.target.value)} /></Field>
            {construction && <Field label="Wohn-/Nutzfläche (m²)"><Input type="number" value={form.area_sqm ?? ''} disabled={ro} onChange={(e) => set('area_sqm', e.target.value ? Number(e.target.value) : null)} /></Field>}
            {construction && <Field label="Geschosse"><Input type="number" value={form.floors ?? ''} disabled={ro} onChange={(e) => set('floors', e.target.value ? Number(e.target.value) : null)} /></Field>}
            <Field label="Projektkalender" hint="Leer = Organisationsstandard; Feiertage der Region gelten immer"><Select value={form.calendar_id ?? ''} disabled={ro} onChange={(e) => set('calendar_id', e.target.value || null)}><option value="">Standard</option>{org.calendars.filter((c) => !c.trade_id && !c.company_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <Field label="Projektstatus"><Select value={form.state ?? 'active'} disabled={ro} onChange={(e) => set('state', e.target.value as ProjectState)}>{(Object.keys(PROJECT_STATE_LABELS) as ProjectState[]).map((s) => <option key={s} value={s}>{PROJECT_STATE_LABELS[s]}</option>)}</Select></Field>
            {construction && <Checkbox label="Keller vorhanden" checked={!!form.has_basement} disabled={ro} onChange={(e) => set('has_basement', e.target.checked)} />}
          </div>
          {!ro && <div className="mt-4 flex justify-end"><Button variant="primary" loading={busy} onClick={() => save()}><Save size={15} /> Speichern</Button></div>}
          <p className="mt-2 text-[11px] text-ink-faint">{construction ? 'Baustart' : 'Projektstart'} nachträglich ändern: automatisch geplante Vorgänge folgen dem neuen Start; auf Wunsch wandern auch fixierte Termine mit. Der {construction ? 'Fertigstellungs' : 'Ziel'}termin ist ein Soll – die Prognose ergibt sich aus dem Plan.</p>
        </Card>
        <Card title={construction ? 'Bauabschnitte' : 'Abschnitte'} actions={!ro && <div className="flex items-center gap-1.5"><Input value={newSection} placeholder="z. B. OG" className="h-8 w-40 text-xs" onChange={(e) => setNewSection(e.target.value)} onKeyDown={async (e) => { if (e.key === 'Enter' && newSection.trim()) { await api.sections.create(p.projectId, newSection.trim()); setNewSection(''); await p.reloadMeta() } }} /><Button size="sm" disabled={!newSection.trim()} onClick={async () => { await api.sections.create(p.projectId, newSection.trim()); setNewSection(''); await p.reloadMeta() }}><Plus size={13} /></Button></div>}>
          {p.bundle.sections.length === 0 ? <p className="text-sm text-ink-faint">{construction ? 'Keine Bauabschnitte – z. B. Keller, EG, OG, Dach, Außen.' : 'Keine Abschnitte – optional, z. B. Bauteil A / Bauteil B.'}</p> : (
            <ul className="flex flex-wrap gap-2">
              {p.bundle.sections.map((s) => <li key={s.id} className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-sm">{s.name}<span className="text-xs text-ink-faint">({p.plan.tasks.filter((t) => t.section_id === s.id).length})</span>{!ro && <button type="button" className="text-ink-faint hover:text-danger" title="Entfernen" onClick={async () => { if (confirm(`Bauabschnitt „${s.name}“ entfernen? Vorgänge bleiben erhalten.`)) { await api.sections.remove(p.projectId, s.id); await p.reloadMeta() } }}><Trash2 size={12} /></button>}</li>)}
            </ul>
          )}
        </Card>
        <BuildFlowPanel />
        <RulesPanel projectId={p.projectId} />
        {(can('templates.manage') || can('project.delete') || can('plan.edit')) && (
          <Card title="Weitere Aktionen">
            <div className="flex flex-wrap gap-2">
              {can('plan.edit') && <Button variant="primary" onClick={() => setAssistOpen(true)}><Sparkles size={15} /> Aufgaben ergänzen (KI, Dokument, Lucidchart, Jira)</Button>}
              {can('plan.edit') && <Button onClick={() => setImportOpen(true)}><Upload size={15} /> Import (CSV / Kalkulation)</Button>}

              {can('project.create') && <Button onClick={() => setCopyDialog({ name: `${p.bundle!.project.name} (Kopie)`, number: '', start: p.bundle!.project.start_date })}><FolderPlus size={15} /> Projekt kopieren</Button>}
              {can('templates.manage') && <Button onClick={asTemplate}><LayoutTemplate size={15} /> Als Vorlage speichern</Button>}
              {can('project.delete') && <Button variant="danger" onClick={remove}><Trash2 size={15} /> Projekt löschen</Button>}
            </div>
          </Card>
        )}
      </div>
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
      <Modal open={!!shiftDialog} onClose={() => setShiftDialog(null)} title="Projektstart ändern" width="sm" footer={<><Button variant="ghost" onClick={() => setShiftDialog(null)}>Abbrechen</Button><Button variant="primary" loading={busy} onClick={() => save(!!shiftDialog?.shift)}>Speichern</Button></>}>
        {shiftDialog && (
          <div className="space-y-3 text-sm">
            <p>Projektstart <b>{formatDate(shiftDialog.from)}</b> → <b>{formatDate(shiftDialog.to)}</b>.</p>
            <Checkbox label="Alle Vorgänge entsprechend verschieben (auch fixierte Termine und Einschränkungen)" checked={shiftDialog.shift} onChange={(e) => setShiftDialog({ ...shiftDialog, shift: e.target.checked })} />
            <p className="text-xs text-ink-faint">Ohne Haken folgen nur automatisch geplante Vorgänge dem neuen Start; manuell fixierte Termine bleiben stehen. Erledigte Vorgänge und Ist-Termine werden nie verschoben. Alles landet in der Historie.</p>
          </div>
        )}
      </Modal>
      <Modal open={!!copyDialog} onClose={() => setCopyDialog(null)} title="Projekt kopieren" width="sm" footer={<><Button variant="ghost" onClick={() => setCopyDialog(null)}>Abbrechen</Button><Button variant="primary" loading={busy} disabled={!copyDialog?.name.trim()} onClick={async () => { if (!copyDialog) return; setBusy(true); try { const np = await api.projects.duplicate(p.projectId, { name: copyDialog.name, number: copyDialog.number, start_date: copyDialog.start, reset_progress: true }); toast.push('Projekt kopiert.', 'success'); navigate(`/projects/${np.id}/gantt`) } catch (e) { toast.push((e as Error).message, 'error') } finally { setBusy(false) } }}>Kopie anlegen</Button></>}>
        {copyDialog && (
          <div className="space-y-3">
            <Field label="Projektname" required><Input value={copyDialog.name} onChange={(e) => setCopyDialog({ ...copyDialog, name: e.target.value })} autoFocus /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Projektnummer"><Input value={copyDialog.number} onChange={(e) => setCopyDialog({ ...copyDialog, number: e.target.value })} /></Field>
              <Field label="Neuer Projektstart" hint="Termine werden relativ verschoben"><Input type="date" value={copyDialog.start} onChange={(e) => setCopyDialog({ ...copyDialog, start: e.target.value })} /></Field>
            </div>
            <p className="text-xs text-ink-faint">Kopiert den kompletten Plan (Phasen, Vorgänge, Abhängigkeiten, Voraussetzungen, Abschnitte). Fortschritt und Ist-Termine werden zurückgesetzt. Nur ausgewählte Vorgänge kopieren: im Terminplan markieren → Rechtsklick → „… als neues Projekt“.</p>
          </div>
        )}
      </Modal>
    </div>
  )
}
