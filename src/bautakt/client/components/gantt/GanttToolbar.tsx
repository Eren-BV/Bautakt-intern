/**
 * Werkzeugleiste des Terminplans: Umschalter Gantt/Kanban, im Gantt zusätzlich Ansichten
 * (Gesamt/Kategorien/Phasen/Abschnitte), Zeitskala, Zeilenhöhe, Auf-/Zuklappen, Spalten,
 * Baseline. In beiden Modi: Anlegen, Undo/Redo, Filter, Kritischer Weg, Szenario,
 * Plan prüfen, Export.
 */

import { useState } from 'react'
import clsx from 'clsx'
import { Plus, Undo2, Redo2, ZoomIn, ZoomOut, Rows2, Rows3, Filter, Search, X, Flag, Layers, GitCompare, Columns3, ChevronsDownUp, ChevronsUpDown, Save, Download, FlaskConical, ShieldCheck, Package, ChevronDown, FileText, Sparkles, FileUp, GanttChartSquare, LayoutGrid } from 'lucide-react'
import type { GanttFilters, GanttView } from './rows'
import { hasActiveFilter, EMPTY_FILTERS } from './rows'
import type { ViewMode } from './scale'
import { ALL_COLUMNS, DEFAULT_COLUMNS, OPTIONAL_COLUMNS, type ColumnKey } from './GanttTableRow'
import { Button, Checkbox, IconButton, Input, Select, Tabs, Kbd } from '../ui'
import { useOrg } from '../../store/org'
import { TASK_STATUS_LABELS } from '../../../shared/labels'
import type { ProjectSection, TaskStatus } from '../../../shared/types'

interface Props {
  layoutMode: 'gantt' | 'kanban'
  onLayoutMode(m: 'gantt' | 'kanban'): void
  view: ViewMode
  onView(v: ViewMode): void
  ganttView: GanttView
  onGanttView(v: GanttView): void
  onZoom(dir: 1 | -1): void
  onRowHeight(dir: 1 | -1): void
  filters: GanttFilters
  onFilters(f: GanttFilters): void
  sections: ProjectSection[]
  showBaseline: boolean
  onShowBaseline(v: boolean): void
  hasBaseline: boolean
  columns: ColumnKey[]
  onColumns(c: ColumnKey[]): void
  canUndo: boolean
  canRedo: boolean
  onUndo(): void
  onRedo(): void
  onAdd(kind: 'task' | 'phase' | 'milestone'): void
  onInsertPackage(): void
  onInsertAssist(mode: 'ai' | 'import'): void
  onExpandAll(): void
  onCollapseAll(): void
  onSaveBaseline(): void
  onScenario(): void
  onCheck(): void
  onExport(kind: 'pdf' | 'csv'): void
  readOnly: boolean
  saving: boolean
  dirty: boolean
  scenarioName?: string
  selectionCount: number
}

export function GanttToolbar(p: Props) {
  const org = useOrg()
  const [open, setOpen] = useState<'filter' | 'columns' | 'export' | 'add' | null>(null)
  const active = hasActiveFilter(p.filters)
  const set = (patch: Partial<GanttFilters>) => p.onFilters({ ...p.filters, ...patch })
  const toggleCol = (k: ColumnKey) => p.onColumns(p.columns.includes(k) ? p.columns.filter((c) => c !== k) : ALL_COLUMNS.filter((c) => p.columns.includes(c.key) || c.key === k).map((c) => c.key))

  return (
    <div className="no-print border-b border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Tabs value={p.layoutMode} onChange={p.onLayoutMode} items={[{ value: 'gantt', label: <span className="flex items-center gap-1.5"><GanttChartSquare size={14} /> Gantt</span> }, { value: 'kanban', label: <span className="flex items-center gap-1.5"><LayoutGrid size={14} /> Kanban</span> }]} />
        <span className="mx-1 h-5 w-px bg-line" />
        {p.layoutMode === 'gantt' && (
          <>
            <Tabs value={p.ganttView} onChange={p.onGanttView} items={[{ value: 'all', label: 'Gesamt' }, { value: 'trade', label: 'Kategorien' }, { value: 'phase', label: 'Phasen' }, { value: 'section', label: 'Abschnitte' }]} />
            <span className="mx-1 h-5 w-px bg-line" />
            <Tabs value={p.view} onChange={p.onView} items={[{ value: 'day', label: 'Tag' }, { value: 'week', label: 'Woche' }, { value: 'month', label: 'Monat' }, { value: 'quarter', label: 'Quartal' }]} />
            <IconButton title="Vergrößern" onClick={() => p.onZoom(1)}><ZoomIn size={16} /></IconButton>
            <IconButton title="Verkleinern" onClick={() => p.onZoom(-1)}><ZoomOut size={16} /></IconButton>
            <IconButton title="Zeilen höher" onClick={() => p.onRowHeight(1)}><Rows3 size={16} /></IconButton>
            <IconButton title="Zeilen niedriger" onClick={() => p.onRowHeight(-1)}><Rows2 size={16} /></IconButton>
            <IconButton title="Alle aufklappen" onClick={p.onExpandAll}><ChevronsUpDown size={16} /></IconButton>
            <IconButton title="Alle zuklappen" onClick={p.onCollapseAll}><ChevronsDownUp size={16} /></IconButton>
          </>
        )}
        {!p.readOnly && (
          <>
            <span className="mx-1 h-5 w-px bg-line" />
            <IconButton title="Rückgängig (Strg+Z)" disabled={!p.canUndo} onClick={p.onUndo}><Undo2 size={16} /></IconButton>
            <IconButton title="Wiederholen (Strg+Y)" disabled={!p.canRedo} onClick={p.onRedo}><Redo2 size={16} /></IconButton>
          </>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {p.selectionCount > 1 && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">{p.selectionCount} ausgewählt – gemeinsam ziehen</span>}
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
            <Input value={p.filters.search} onChange={(e) => set({ search: e.target.value })} placeholder="Suchen …" className="h-8 w-40 pl-8 text-xs" />
          </div>
          <Button size="sm" variant={active ? 'primary' : 'secondary'} onClick={() => setOpen(open === 'filter' ? null : 'filter')}><Filter size={14} /> Filter{active ? ' •' : ''}</Button>
          <Button size="sm" variant={p.filters.criticalOnly ? 'primary' : 'secondary'} onClick={() => set({ criticalOnly: !p.filters.criticalOnly })} className={clsx(p.filters.criticalOnly && 'bg-danger hover:bg-red-700')}>Kritischer Weg</Button>
          {p.layoutMode === 'gantt' && p.hasBaseline && <Button size="sm" variant={p.showBaseline ? 'primary' : 'secondary'} onClick={() => p.onShowBaseline(!p.showBaseline)}><GitCompare size={14} /> Baseline</Button>}
          {p.layoutMode === 'gantt' && (
            <div className="relative">
              <Button size="sm" onClick={() => setOpen(open === 'columns' ? null : 'columns')}><Columns3 size={14} /> Spalten</Button>
              {open === 'columns' && (
                <Menu onClose={() => setOpen(null)}>
                  <div className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Optionale Spalten</div>
                  {OPTIONAL_COLUMNS.map((k) => <label key={k} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2"><input type="checkbox" className="accent-brand" checked={p.columns.includes(k)} onChange={() => toggleCol(k)} />{ALL_COLUMNS.find((c) => c.key === k)!.label}</label>)}
                  <button type="button" className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-brand hover:bg-surface-2" onClick={() => p.onColumns(DEFAULT_COLUMNS)}>Standard (Vorgang, Start, Ende, Dauer)</button>
                </Menu>
              )}
            </div>
          )}
          {!p.readOnly && !p.scenarioName && <Button size="sm" onClick={p.onScenario}><FlaskConical size={14} /> Szenario</Button>}
          <Button size="sm" onClick={p.onCheck}><ShieldCheck size={14} /> Plan prüfen</Button>
          <div className="relative">
            <Button size="sm" onClick={() => setOpen(open === 'export' ? null : 'export')}><Download size={14} /> Export <ChevronDown size={12} /></Button>
            {open === 'export' && (
              <Menu onClose={() => setOpen(null)}>
                <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2" onClick={() => { p.onExport('pdf'); setOpen(null) }}><FileText size={14} className="text-ink-faint" /> Gesamtterminplan als PDF</button>
                <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2" onClick={() => { p.onExport('csv'); setOpen(null) }}><Download size={14} className="text-ink-faint" /> Vorgänge als CSV</button>
              </Menu>
            )}
          </div>
          {!p.readOnly && <Button size="sm" onClick={() => p.onInsertAssist('ai')}><Sparkles size={14} /> KI</Button>}
          {!p.readOnly && <Button size="sm" onClick={() => p.onInsertAssist('import')}><FileUp size={14} /> Import</Button>}
          {!p.readOnly && (
            <div className="relative">
              <Button size="sm" variant="primary" onClick={() => setOpen(open === 'add' ? null : 'add')}><Plus size={14} /> Vorgang <ChevronDown size={12} /></Button>
              {open === 'add' && (
                <Menu onClose={() => setOpen(null)}>
                  <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2" onClick={() => { p.onAdd('task'); setOpen(null) }}><Plus size={14} className="text-ink-faint" /> Vorgang</button>
                  <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2" onClick={() => { p.onAdd('phase'); setOpen(null) }}><Layers size={14} className="text-ink-faint" /> Phase</button>
                  <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2" onClick={() => { p.onAdd('milestone'); setOpen(null) }}><Flag size={14} className="text-ink-faint" /> Meilenstein</button>
                  <div className="my-1 border-t border-line" />
                  <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2" onClick={() => { p.onInsertPackage(); setOpen(null) }}><Package size={14} className="text-ink-faint" /> Arbeitspaket einfügen …</button>
                  {!p.scenarioName && <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2" onClick={() => { p.onSaveBaseline(); setOpen(null) }}><Save size={14} className="text-ink-faint" /> Plan freigeben / Baseline erstellen</button>}
                </Menu>
              )}
            </div>
          )}
          <span className="w-20 text-right text-[11px] text-ink-faint">{p.saving ? 'Speichert …' : p.dirty ? 'Ungespeichert' : 'Gespeichert'}</span>
        </div>
      </div>
      {open === 'filter' && (
        <div className="flex flex-wrap items-end gap-3 border-t border-line bg-surface-2 px-3 py-2">
          <label className="text-xs"><span className="mb-1 block text-ink-faint">Kategorie</span><Select value={p.filters.trade} onChange={(e) => set({ trade: e.target.value })} className="h-8 w-40 text-xs"><option value="">Alle</option>{org.trades.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
          <label className="text-xs"><span className="mb-1 block text-ink-faint">Firma</span><Select value={p.filters.company} onChange={(e) => set({ company: e.target.value })} className="h-8 w-40 text-xs"><option value="">Alle</option>{org.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></label>
          <label className="text-xs"><span className="mb-1 block text-ink-faint">Verantwortlicher</span><Select value={p.filters.responsible} onChange={(e) => set({ responsible: e.target.value })} className="h-8 w-40 text-xs"><option value="">Alle</option>{org.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.user?.name}</option>)}</Select></label>
          <label className="text-xs"><span className="mb-1 block text-ink-faint">Abschnitt</span><Select value={p.filters.section} onChange={(e) => set({ section: e.target.value })} className="h-8 w-36 text-xs"><option value="">Alle</option>{p.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></label>
          <label className="text-xs"><span className="mb-1 block text-ink-faint">Status</span><Select value={p.filters.status} onChange={(e) => set({ status: e.target.value as TaskStatus | '' })} className="h-8 w-36 text-xs"><option value="">Alle</option>{(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>)}</Select></label>
          <label className="text-xs"><span className="mb-1 block text-ink-faint">Zeitraum von</span><Input type="date" value={p.filters.from} onChange={(e) => set({ from: e.target.value })} className="h-8 w-36 text-xs" /></label>
          <label className="text-xs"><span className="mb-1 block text-ink-faint">bis</span><Input type="date" value={p.filters.to} onChange={(e) => set({ to: e.target.value })} className="h-8 w-36 text-xs" /></label>
          <Checkbox label="Nur verspätete" checked={p.filters.delayedOnly} onChange={(e) => set({ delayedOnly: e.target.checked })} className="pb-2" />
          <Checkbox label="Nur Meilensteine" checked={p.filters.milestonesOnly} onChange={(e) => set({ milestonesOnly: e.target.checked })} className="pb-2" />
          <Button size="sm" variant="ghost" onClick={() => p.onFilters(EMPTY_FILTERS)} disabled={!active}><X size={13} /> Zurücksetzen</Button>
          <span className="ml-auto pb-2 text-[11px] text-ink-faint">Rechtsklick = Kontextmenü · <Kbd>Strg</Kbd>+Klick = Mehrfachauswahl · <Kbd>↑↓</Kbd> navigieren · <Kbd>Enter</Kbd> öffnen · <Kbd>Entf</Kbd> löschen</span>
        </div>
      )}
    </div>
  )
}

function Menu({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="animate-fade-in absolute right-0 z-50 mt-1 min-w-56 rounded-lg border border-line bg-surface p-1.5 shadow-xl">{children}</div>
    </>
  )
}
