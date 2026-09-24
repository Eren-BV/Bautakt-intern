/**
 * Vorlagen: mitgelieferte und eigene Projektstrukturen (Phasen, Vorgänge, Dauern,
 * Gewerke, Abhängigkeiten, Meilensteine). Eigene Vorlagen sind im Tabellen-Editor
 * bearbeitbar; mitgelieferte werden zum Bearbeiten kopiert.
 */

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Copy, Plus, Trash2, Save, ArrowUp, ArrowDown, Diamond, Layers } from 'lucide-react'
import { api } from '../lib/api'
import { useOrg } from '../store/org'
import { useAuth } from '../store/auth'
import { useToast } from '../store/toast'
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Textarea, Tabs } from '../components/ui'
import { WorkPackagesPanel } from '../components/WorkPackagesPanel'
import type { ProjectTemplate, TemplateTask, TaskType } from '../../shared/types'
import { PROJECT_TYPE_LABELS, CONSTRUCTION_LABELS, PLANNING_KIND_LABELS } from '../../shared/labels'

type Tpl = ProjectTemplate & { task_count: number }

export function TemplatesPage() {
  const org = useOrg()
  const { can } = useAuth()
  const toast = useToast()
  const [list, setList] = useState<Tpl[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ template: ProjectTemplate; tasks: TemplateTask[] } | null>(null)
  const [draft, setDraft] = useState<TemplateTask[] | null>(null)
  const [meta, setMeta] = useState<{ name: string; description: string }>({ name: '', description: '' })
  const [newDialog, setNewDialog] = useState<{ name: string; copy_of: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<'projects' | 'packages'>('projects')
  const ro = !can('templates.manage')

  const load = () => api.templates.list().then((l) => { setList(l); if (!selected && l[0]) setSelected(l[0].id) }).catch((e) => toast.push(e.message, 'error'))
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!selected) return
    api.templates.get(selected).then((d) => { setDetail(d); setDraft(d.tasks); setMeta({ name: d.template.name, description: d.template.description }) }).catch((e) => toast.push(e.message, 'error'))
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  const editable = !!detail && !detail.template.is_builtin && !ro
  const dirty = useMemo(() => detail && draft && (JSON.stringify(draft) !== JSON.stringify(detail.tasks) || meta.name !== detail.template.name || meta.description !== detail.template.description), [detail, draft, meta])
  const totalDuration = useMemo(() => (draft ?? []).filter((t) => t.type !== 'phase').reduce((s, t) => s + t.duration, 0), [draft])

  const save = async () => {
    if (!detail || !draft) return
    setBusy(true)
    try {
      const d = await api.templates.update(detail.template.id, { name: meta.name, description: meta.description, tasks: draft })
      setDetail(d)
      setDraft(d.tasks)
      await load()
      toast.push('Vorlage gespeichert.', 'success')
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const createTemplate = async () => {
    if (!newDialog?.name) return
    try {
      const d = await api.templates.create({ name: newDialog.name, copy_of: newDialog.copy_of || undefined })
      setNewDialog(null)
      await load()
      setSelected(d.template.id)
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const removeTemplate = async (id: string) => {
    if (!confirm('Vorlage löschen?')) return
    await api.templates.remove(id)
    setSelected(null)
    setDetail(null)
    await load()
  }

  // ---- Zeilen-Editor
  const upd = (i: number, patch: Partial<TemplateTask>) => setDraft((d) => d!.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  const addRow = (after: number, type: TaskType) => {
    const key = `n${Date.now().toString(36)}`
    const ref = draft![after]
    const row: TemplateTask = { id: '', template_id: detail!.template.id, key, parent_key: type === 'phase' ? null : ref?.type === 'phase' ? ref.key : ref?.parent_key ?? null, name: type === 'phase' ? 'Neue Phase' : type === 'milestone' ? 'Neuer Meilenstein' : 'Neuer Vorgang', type, duration: type === 'task' ? 5 : 0, trade_name: null, section_name: null, sort_order: 0, dependencies: [], constraints: [] }
    setDraft((d) => [...d!.slice(0, after + 1), row, ...d!.slice(after + 1)])
  }
  const move = (i: number, dir: -1 | 1) => setDraft((d) => { const n = [...d!]; const j = i + dir; if (j < 0 || j >= n.length) return d!; [n[i], n[j]] = [n[j], n[i]]; return n })
  const removeRow = (i: number) => setDraft((d) => { const key = d![i].key; return d!.filter((_, j) => j !== i).map((t) => ({ ...t, parent_key: t.parent_key === key ? null : t.parent_key, dependencies: t.dependencies.filter((x) => x.predecessor_key !== key) })) })
  const depsText = (t: TemplateTask) => t.dependencies.map((d) => `${draft!.findIndex((x) => x.key === d.predecessor_key) + 1}${d.type === 'FS' ? '' : d.type}${d.lag_days ? (d.lag_days > 0 ? '+' : '') + d.lag_days : ''}`).join(', ')
  const parseDeps = (text: string): TemplateTask['dependencies'] =>
    text.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const m = s.match(/^(\d+)(FS|SS|FF|SF)?([+-]\d+)?$/i)
      if (!m) return null
      const pred = draft![Number(m[1]) - 1]
      if (!pred) return null
      return { predecessor_key: pred.key, type: (m[2]?.toUpperCase() ?? 'FS') as 'FS', lag_days: m[3] ? Number(m[3]) : 0 }
    }).filter((x): x is NonNullable<typeof x> => !!x)

  if (!list) return <Spinner />
  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <PageHeader title="Vorlagen" subtitle="Projektvorlagen für neue Projekte · Arbeitspakete zum Einfügen in bestehende Projekte" actions={<><Tabs value={kind} onChange={setKind} items={[{ value: 'projects', label: 'Projektvorlagen' }, { value: 'packages', label: 'Arbeitspakete' }]} />{!ro && kind === 'projects' && <Button variant="primary" onClick={() => setNewDialog({ name: '', copy_of: '' })}><Plus size={15} /> Neue Vorlage</Button>}</>} />
      {kind === 'packages' && <WorkPackagesPanel />}
      <div className={kind === 'packages' ? 'hidden' : 'grid gap-6 lg:grid-cols-[320px_1fr]'}>
        <Card title="Vorlagen" padded={false}>
          <ul className="divide-y divide-line">
            {list.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => setSelected(t.id)} className={clsx('flex w-full flex-col gap-0.5 px-4 py-2.5 text-left hover:bg-surface-2', selected === t.id && 'bg-brand-soft/60')}>
                  <div className="flex items-center gap-2"><span className="font-medium">{t.name}</span>{t.is_builtin ? <Badge tone="neutral">mitgeliefert</Badge> : <Badge tone="brand">eigene</Badge>}</div>
                  <div className="text-xs text-ink-faint">{t.planning_kind === 'construction' ? `${t.project_type ? PROJECT_TYPE_LABELS[t.project_type] : '–'} · ${t.construction_method ? CONSTRUCTION_LABELS[t.construction_method] : '–'}` : PLANNING_KIND_LABELS[t.planning_kind]} · {t.task_count} Vorgänge</div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {!detail || !draft ? <EmptyState title="Vorlage auswählen" /> : (
          <Card padded={false} title={
            <div className="flex items-center gap-2">{editable ? <Input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} className="h-8 w-72" /> : detail.template.name}<span className="text-xs font-normal text-ink-faint">{draft.length} Zeilen · Σ {totalDuration} AT Vorgangsdauer</span></div>
          } actions={<>
            {!ro && <Button size="sm" onClick={() => setNewDialog({ name: `${detail.template.name} (Kopie)`, copy_of: detail.template.id })}><Copy size={13} /> Kopieren</Button>}
            {editable && <Button size="sm" variant="ghost" className="text-danger" onClick={() => removeTemplate(detail.template.id)}><Trash2 size={13} /></Button>}
            {editable && <Button size="sm" variant="primary" disabled={!dirty} loading={busy} onClick={save}><Save size={13} /> Speichern</Button>}
          </>}>
            <div className="border-b border-line px-4 py-3">
              {editable ? <Textarea rows={2} value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} placeholder="Beschreibung" /> : <p className="text-sm text-ink-soft">{detail.template.description || 'Keine Beschreibung.'}{detail.template.is_builtin && ' Mitgelieferte Vorlagen sind schreibgeschützt – kopieren Sie sie, um sie anzupassen.'}</p>}
            </div>
            <div className="overflow-x-auto">
              <table className="data-table w-full min-w-[900px] text-sm">
                <thead><tr><th className="w-10 text-right">#</th><th>Bezeichnung</th><th>Typ</th><th className="w-20 text-right">Dauer</th><th>Gewerk</th><th>Vorgänger</th>{editable && <th className="w-36" />}</tr></thead>
                <tbody>
                  {draft.map((t, i) => {
                    const depth = t.parent_key ? 1 : 0
                    return (
                      <tr key={t.key} className={clsx(t.type === 'phase' && 'bg-surface-2/60')}>
                        <td className="text-right text-xs text-ink-faint">{i + 1}</td>
                        <td style={{ paddingLeft: 12 + depth * 20 }}>
                          <div className="flex items-center gap-1.5">
                            {t.type === 'phase' && <Layers size={13} className="text-ink-faint" />}{t.type === 'milestone' && <Diamond size={11} className="fill-milestone text-milestone" />}
                            {editable ? <input value={t.name} onChange={(e) => upd(i, { name: e.target.value })} className={clsx('w-full min-w-0 rounded border border-transparent bg-transparent px-1 hover:border-line focus:border-brand focus:outline-none', t.type === 'phase' && 'font-semibold')} /> : <span className={t.type === 'phase' ? 'font-semibold' : ''}>{t.name}</span>}
                          </div>
                        </td>
                        <td className="text-xs">{editable ? <select value={t.type} onChange={(e) => upd(i, { type: e.target.value as TaskType, duration: e.target.value === 'task' ? Math.max(1, t.duration) : 0, parent_key: e.target.value === 'phase' ? null : t.parent_key })} className="rounded border border-line bg-surface px-1 py-0.5 text-xs"><option value="phase">Phase</option><option value="task">Vorgang</option><option value="milestone">Meilenstein</option></select> : t.type === 'phase' ? 'Phase' : t.type === 'milestone' ? 'Meilenstein' : 'Vorgang'}</td>
                        <td className="text-right text-xs">{t.type === 'task' ? (editable ? <input type="number" min={1} value={t.duration} onChange={(e) => upd(i, { duration: Number(e.target.value) || 1 })} className="w-16 rounded border border-line bg-surface px-1 py-0.5 text-right text-xs" /> : `${t.duration} AT`) : '–'}</td>
                        <td className="text-xs">{t.type !== 'phase' && (editable ? <select value={t.trade_name ?? ''} onChange={(e) => upd(i, { trade_name: e.target.value || null })} className="max-w-[140px] rounded border border-line bg-surface px-1 py-0.5 text-xs"><option value="">–</option>{org.trades.map((tr) => <option key={tr.id} value={tr.name}>{tr.name}</option>)}</select> : t.trade_name ?? '–')}</td>
                        <td className="text-xs text-ink-soft">{t.type !== 'phase' && (editable ? <input defaultValue={depsText(t)} key={depsText(t) + t.key} onBlur={(e) => upd(i, { dependencies: parseDeps(e.target.value) })} placeholder="z. B. 3, 5SS+2" className="w-32 rounded border border-line bg-surface px-1 py-0.5 text-xs" /> : depsText(t))}</td>
                        {editable && (
                          <td className="whitespace-nowrap text-right">
                            <IconButton title="Vorgang danach" className="h-7 w-7" onClick={() => addRow(i, 'task')}><Plus size={13} /></IconButton>
                            <IconButton title="Nach oben" className="h-7 w-7" onClick={() => move(i, -1)}><ArrowUp size={13} /></IconButton>
                            <IconButton title="Nach unten" className="h-7 w-7" onClick={() => move(i, 1)}><ArrowDown size={13} /></IconButton>
                            <IconButton title="Entfernen" className="h-7 w-7" onClick={() => removeRow(i)}><Trash2 size={13} /></IconButton>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {editable && <div className="flex gap-2 border-t border-line px-4 py-2"><Button size="sm" onClick={() => addRow(draft.length - 1, 'phase')}><Layers size={13} /> Phase</Button><Button size="sm" onClick={() => addRow(draft.length - 1, 'task')}><Plus size={13} /> Vorgang</Button><Button size="sm" onClick={() => addRow(draft.length - 1, 'milestone')}><Diamond size={13} /> Meilenstein</Button><span className="ml-auto self-center text-xs text-ink-faint">Vorgänger als Zeilennummern: „3“ (FS), „5SS+2“, „7FF-1“</span></div>}
          </Card>
        )}
      </div>
      <Modal open={!!newDialog} onClose={() => setNewDialog(null)} title="Neue Vorlage" width="sm" footer={<><Button variant="ghost" onClick={() => setNewDialog(null)}>Abbrechen</Button><Button variant="primary" disabled={!newDialog?.name} onClick={createTemplate}>Anlegen</Button></>}>
        {newDialog && (
          <div className="space-y-3">
            <Field label="Name" required><Input value={newDialog.name} onChange={(e) => setNewDialog({ ...newDialog, name: e.target.value })} autoFocus /></Field>
            <Field label="Basis"><Select value={newDialog.copy_of} onChange={(e) => setNewDialog({ ...newDialog, copy_of: e.target.value })}><option value="">Leer</option>{list.map((t) => <option key={t.id} value={t.id}>Kopie von: {t.name}</option>)}</Select></Field>
          </div>
        )}
      </Modal>
    </div>
  )
}
