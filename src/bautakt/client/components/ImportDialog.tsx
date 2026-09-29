/**
 * Import (CSV): Datei → Vorschau mit erkanntem Spalten-Mapping (änderbar) → Validierung →
 * Review → Übernahme als Vorgänge (unter einem Elternknoten) oder als Kalkulationspositionen.
 */

import { useState } from 'react'
import { Upload, AlertTriangle, Info } from 'lucide-react'
import { useProject } from '../store/project'
import { useToast } from '../store/toast'
import { api } from '../lib/api'
import { Button, Field, Modal, Select, Textarea } from './ui'
import type { ImportMapping, NormalizedItem } from '../../shared/import/pipeline'
import { flattenTree } from '../../shared/engine/operations'

const FIELDS: { key: keyof ImportMapping; label: string }[] = [
  { key: 'description', label: 'Bezeichnung' }, { key: 'position', label: 'Position' }, { key: 'quantity', label: 'Menge' }, { key: 'unit', label: 'Einheit' }, { key: 'trade', label: 'Kategorie' },
  { key: 'section', label: 'Abschnitt' }, { key: 'duration', label: 'Dauer (AT)' }, { key: 'productivity_rate', label: 'Leistungswert' }, { key: 'start', label: 'Start' }, { key: 'predecessor_row', label: 'Vorgänger (Zeile)' }, { key: 'lag', label: 'Lag' }, { key: 'unit_price', label: 'EP' }, { key: 'total_price', label: 'GP' },
]

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const p = useProject()
  const toast = useToast()
  const [csv, setCsv] = useState('')
  const [filename, setFilename] = useState('import.csv')
  const [preview, setPreview] = useState<{ headers: string[]; row_count: number; mapping: ImportMapping; items: NormalizedItem[]; validation: { errors: string[]; warnings: string[] } } | null>(null)
  const [override, setOverride] = useState<Partial<ImportMapping>>({})
  const [mode, setMode] = useState<'tasks' | 'estimate'>('tasks')
  const [parentId, setParentId] = useState('')
  const [busy, setBusy] = useState(false)

  const runPreview = async (text = csv, ov = override) => {
    try {
      setPreview(await api.imports.preview(p.projectId, text, ov))
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const onFile = async (f: File) => {
    const text = await f.text()
    setCsv(text)
    setFilename(f.name)
    await runPreview(text)
  }
  const apply = async () => {
    setBusy(true)
    try {
      const r = await api.imports.apply(p.projectId, { csv, mapping: override, mode, parent_id: parentId || null, filename, expected_version: p.bundle?.project.version ?? 0 })
      toast.push(mode === 'tasks' ? `${r.tasks_created} Vorgänge importiert.` : `${r.items} Kalkulationspositionen importiert.`, 'success')
      await p.reload()
      onClose()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const example = 'Bezeichnung;Kategorie;Dauer;Vorgänger;Menge;Einheit;Leistung\nInnenputz EG;Innenputz;5;;520;m²;110\nEstrich;Estrich;3;1+3;280;m²;100\nFliesen;Fliesen;6;2;120;m²;25'

  return (
    <Modal open onClose={onClose} title="Import (CSV)" width="xl" footer={<><Button variant="ghost" onClick={onClose}>Abbrechen</Button><Button variant="primary" loading={busy} disabled={!preview || preview.validation.errors.length > 0} onClick={apply}>{mode === 'tasks' ? 'Als Vorgänge übernehmen' : 'Als Kalkulation übernehmen'}</Button></>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2"><Upload size={15} /> CSV-Datei wählen<input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} /></label>
          <span className="text-xs text-ink-faint">oder einfügen:</span>
          <Button size="sm" variant="ghost" onClick={() => { setCsv(example); void runPreview(example) }}>Beispiel laden</Button>
          <span className="ml-auto text-[11px] text-ink-faint">Pipeline: Datei → Parser → Normalisierung → Mapping → Validierung → Review → Projekt · Excel/GAEB/IFC als Parser vorbereitet</span>
        </div>
        <Textarea rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} onBlur={() => csv && runPreview()} placeholder="Bezeichnung;Kategorie;Dauer;Vorgänger;Menge;Einheit;Leistung" className="font-mono text-xs" />
        {preview && (
          <>
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface-2 p-3">
              <div className="w-full text-xs font-semibold text-ink-soft">Spalten-Zuordnung ({preview.row_count} Zeilen erkannt)</div>
              {FIELDS.map((f) => (
                <label key={f.key} className="text-[11px]"><span className="mb-0.5 block text-ink-faint">{f.label}</span>
                  <Select value={preview.mapping[f.key] ?? ''} className="h-7 w-36 text-xs" onChange={(e) => { const ov = { ...override, [f.key]: e.target.value || null }; setOverride(ov); void runPreview(csv, ov) }}><option value="">–</option>{preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}</Select>
                </label>
              ))}
            </div>
            {preview.validation.errors.map((e, i) => <div key={i} className="flex items-center gap-2 rounded-md bg-danger-soft px-3 py-1.5 text-xs text-danger"><AlertTriangle size={13} /> {e}</div>)}
            {preview.validation.warnings.slice(0, 5).map((w, i) => <div key={i} className="flex items-center gap-2 rounded-md bg-warn-soft px-3 py-1.5 text-xs text-warn"><Info size={13} /> {w}</div>)}
            <div className="max-h-64 overflow-auto rounded-lg border border-line">
              <table className="data-table w-full text-xs"><thead><tr><th>#</th><th>Bezeichnung</th><th>Kategorie</th><th>Abschnitt</th><th className="text-right">Menge</th><th className="text-right">Dauer</th><th>Vorgänger</th><th>Start</th></tr></thead>
                <tbody>{preview.items.slice(0, 50).map((it) => <tr key={it.row}><td>{it.row + 1}</td><td className="font-medium">{it.description}</td><td>{it.trade ?? ''}</td><td>{it.section ?? ''}</td><td className="text-right">{it.quantity ?? ''} {it.unit ?? ''}</td><td className="text-right">{it.duration ?? (it.quantity && it.productivity_rate ? `≈${Math.ceil(it.quantity / it.productivity_rate)}` : '1')} AT</td><td>{it.predecessor_row !== null ? `Zeile ${it.predecessor_row + 1} ${it.dep_type ?? 'FS'}${it.lag ? (it.lag > 0 ? '+' : '') + it.lag : ''}` : ''}</td><td>{it.start ?? ''}</td></tr>)}</tbody></table>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Übernehmen als"><Select value={mode} onChange={(e) => setMode(e.target.value as 'tasks')}><option value="tasks">Vorgänge im Terminplan (+ Kalkulationsverknüpfung)</option><option value="estimate">Nur Kalkulationspositionen (Verknüpfung später)</option></Select></Field>
              {mode === 'tasks' && <Field label="Einfügen unter"><Select value={parentId} onChange={(e) => setParentId(e.target.value)}><option value="">Oberste Ebene</option>{flattenTree(p.plan.tasks).filter((f) => f.task.type !== 'milestone').map((f) => <option key={f.task.id} value={f.task.id}>{' '.repeat(f.depth * 2)}{f.task.name}</option>)}</Select></Field>}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
