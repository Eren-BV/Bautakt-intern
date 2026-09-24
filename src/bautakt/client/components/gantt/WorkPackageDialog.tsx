/**
 * Arbeitspaket in das aktuelle Projekt einfügen: Paket wählen, Position (Elternknoten),
 * Bauabschnitt, Start (fester Termin oder nach einem Vorgänger). Terminierung durch die Engine.
 */

import { useEffect, useState } from 'react'
import { useProject } from '../../store/project'
import { useToast } from '../../store/toast'
import { api } from '../../lib/api'
import { Button, Field, Input, Modal, Select } from '../ui'
import type { WorkPackageTask, WorkPackageTemplate } from '../../../shared/types'
import { flattenTree } from '../../../shared/engine/operations'

export function WorkPackageDialog({ defaultParentId, onClose }: { defaultParentId: string | null; onClose: () => void }) {
  const p = useProject()
  const toast = useToast()
  const [list, setList] = useState<(WorkPackageTemplate & { task_count: number })[]>([])
  const [selected, setSelected] = useState('')
  const [preview, setPreview] = useState<WorkPackageTask[]>([])
  const [parentId, setParentId] = useState<string>(defaultParentId ?? '')
  const [sectionId, setSectionId] = useState('')
  const [mode, setMode] = useState<'date' | 'after'>('after')
  const [startDate, setStartDate] = useState(p.today)
  const [predecessorId, setPredecessorId] = useState('')
  const [rootName, setRootName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.workPackages.list().then((l) => { setList(l); if (l[0]) setSelected(l[0].id) }).catch((e) => toast.push(e.message, 'error'))
  }, [toast])
  useEffect(() => {
    if (!selected) return
    api.workPackages.get(selected).then((d) => { setPreview(d.tasks); setRootName(d.package.name) }).catch(() => setPreview([]))
  }, [selected])
  const flat = flattenTree(p.plan.tasks)
  const parents = flat.filter((f) => f.task.type !== 'milestone')

  const insert = async () => {
    setBusy(true)
    try {
      const res = await api.workPackages.insert(p.projectId, selected, { parent_id: parentId || null, after_id: null, start_date: mode === 'date' ? startDate : null, predecessor_id: mode === 'after' ? predecessorId || null : null, section_id: sectionId || null, root_name: rootName || undefined, expected_version: p.bundle?.project.version ?? 0 })
      toast.push(`Arbeitspaket eingefügt (${res.inserted_ids.length} Vorgänge).`, 'success')
      await p.reload()
      onClose()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const total = preview.filter((t) => t.type === 'task').reduce((s, t) => s + t.duration, 0)

  return (
    <Modal open onClose={onClose} title="Arbeitspaket einfügen" width="lg" footer={<><Button variant="ghost" onClick={onClose}>Abbrechen</Button><Button variant="primary" loading={busy} disabled={!selected || (mode === 'after' && !predecessorId)} onClick={insert}>Einfügen</Button></>}>
      <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
        <div className="space-y-3">
          <Field label="Arbeitspaket"><Select value={selected} onChange={(e) => setSelected(e.target.value)}>{list.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.task_count} Schritte)</option>)}</Select></Field>
          <Field label="Bezeichnung im Projekt" hint="z. B. „Bad OG“"><Input value={rootName} onChange={(e) => setRootName(e.target.value)} /></Field>
          <Field label="Einfügen unter"><Select value={parentId} onChange={(e) => setParentId(e.target.value)}><option value="">Oberste Ebene</option>{parents.map((f) => <option key={f.task.id} value={f.task.id}>{' '.repeat(f.depth * 2)}{f.task.name}</option>)}</Select></Field>
          <Field label="Bauabschnitt"><Select value={sectionId} onChange={(e) => setSectionId(e.target.value)}><option value="">–</option>{(p.bundle?.sections ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <div>
            <div className="mb-1 text-xs font-medium text-ink-soft">Beginn</div>
            <label className="flex items-center gap-2 text-sm"><input type="radio" className="accent-brand" checked={mode === 'after'} onChange={() => setMode('after')} /> nach Abschluss von</label>
            <Select value={predecessorId} disabled={mode !== 'after'} className="mt-1" onChange={(e) => setPredecessorId(e.target.value)}><option value="">– Vorgang wählen –</option>{flat.map((f) => <option key={f.task.id} value={f.task.id}>{' '.repeat(f.depth * 2)}{f.task.name}</option>)}</Select>
            <label className="mt-2 flex items-center gap-2 text-sm"><input type="radio" className="accent-brand" checked={mode === 'date'} onChange={() => setMode('date')} /> frühestens am</label>
            <Input type="date" value={startDate} disabled={mode !== 'date'} className="mt-1" onChange={(e) => setStartDate(e.target.value)} />
          </div>
        </div>
        <div className="rounded-lg border border-line bg-surface-2 p-3">
          <div className="mb-2 text-xs font-semibold text-ink-soft">{list.find((w) => w.id === selected)?.description}</div>
          <ol className="space-y-0.5 text-xs">
            {preview.map((t) => <li key={t.key} style={{ paddingLeft: t.parent_key ? (preview.find((x) => x.key === t.parent_key)?.parent_key ? 24 : 12) : 0 }} className={t.type === 'group' ? 'font-semibold' : ''}>{t.type === 'milestone' ? '◆ ' : ''}{t.name}{t.type === 'task' ? <span className="text-ink-faint"> · {t.duration} AT{t.trade_name ? ` · ${t.trade_name}` : ''}</span> : ''}{t.dependencies.length ? <span className="text-ink-faint"> ← {t.dependencies.map((d) => `${preview.find((x) => x.key === d.predecessor_key)?.name ?? ''}${d.type !== 'FS' ? ' ' + d.type : ''}${d.lag_days ? (d.lag_days > 0 ? '+' : '') + d.lag_days : ''}`).join(', ')}</span> : ''}{t.constraints.length ? <span className="text-warn"> · {t.constraints.length} Voraussetzung{t.constraints.length > 1 ? 'en' : ''}</span> : ''}</li>)}
          </ol>
          <div className="mt-2 text-[11px] text-ink-faint">Σ {total} AT Vorgangsdauer · Abhängigkeiten und Voraussetzungen werden mit eingefügt.</div>
        </div>
      </div>
    </Modal>
  )
}
