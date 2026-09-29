/**
 * Verbindet Projekt-Store, Toolbar, Gantt-Chart, Kontextmenü, Auswirkungsdialog,
 * Drawer, Planprüfung und Arbeitspaket-Dialog. Wird von der Terminplan-Seite und der
 * Szenario-Ansicht genutzt.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pencil, Plus, Flag, Copy, Link2, MoveHorizontal, Trash2, Indent, Outdent, ArrowUp, ArrowDown, Unlock, Layers, Diamond, HelpCircle, Package, FolderPlus, Sparkles, FileUp } from 'lucide-react'
import { useProject } from '../../store/project'
import { useOrg } from '../../store/org'
import { useToast } from '../../store/toast'
import { useRoute, navigate } from '../../lib/router'
import { api } from '../../lib/api'
import { downloadCsv } from '../../lib/export'
import { GanttChart } from './GanttChart'
import { GanttToolbar } from './GanttToolbar'
import { TaskDrawer } from './TaskDrawer'
import { PlanCheckPanel } from './PlanCheckPanel'
import { WorkPackageDialog } from './WorkPackageDialog'
import { PlanAssistDialog } from '../PlanAssistDialog'
import { buildRows, EMPTY_FILTERS, isVirtualId, type GanttFilters, type GanttView } from './rows'
import { buildScale, VIEW_PX, type ViewMode } from './scale'
import { ALL_COLUMNS, DEFAULT_COLUMNS, type ColumnKey } from './GanttTableRow'
import { ROW_HEIGHTS } from './types'
import { ContextMenu, Modal, Button, Field, Input, Spinner, ErrorBox, type MenuItem } from '../ui'
import { toDayNumber, formatDate } from '../../../shared/engine/dates'
import { floatLabel } from '../../../shared/engine/explain'
import { explainSpan } from '../../../shared/engine/calendar'
import * as ops from '../../../shared/engine/operations'
import type { Task, ISODate } from '../../../shared/types'
import { TASK_STATUS_LABELS } from '../../../shared/labels'
import * as jarvisBus from '../../jarvis/bus'

const STORAGE = 'bautakt.gantt.v1'

interface Prefs {
  view: ViewMode
  ganttView: GanttView
  tableWidth: number
  columns: ColumnKey[]
  showBaseline: boolean
  rowH: number
}
function loadPrefs(): Prefs {
  const def: Prefs = { view: 'week', ganttView: 'all', tableWidth: 640, columns: DEFAULT_COLUMNS, showBaseline: true, rowH: 36 }
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Partial<Prefs> & { companyDefaulted?: boolean }
    const merged: Prefs = { ...def, ...stored }
    // Firma ist neue Standardspalte: einmalig in bestehende Ansichten einfügen (nach „Vorgang“)
    if (!stored.companyDefaulted && Array.isArray(stored.columns) && !stored.columns.includes('company')) {
      const cols = [...stored.columns]
      const at = cols.indexOf('name')
      cols.splice(at >= 0 ? at + 1 : cols.length, 0, 'company')
      merged.columns = cols
      merged.tableWidth = Math.max(merged.tableWidth, 640)
    }
    return merged
  } catch {
    return def
  }
}

export function GanttWorkspace() {
  const p = useProject()
  const org = useOrg()
  const toast = useToast()
  const { query } = useRoute()
  const [prefs] = useState(loadPrefs)
  const [view, setView] = useState<ViewMode>(prefs.view)
  const [ganttView, setGanttView] = useState<GanttView>(prefs.ganttView)
  const [zoom, setZoom] = useState(1)
  const [tableWidth, setTableWidth] = useState(prefs.tableWidth)
  const [columns, setColumns] = useState<ColumnKey[]>(prefs.columns)
  const [showBaseline, setShowBaseline] = useState(prefs.showBaseline)
  const [rowH, setRowH] = useState<number>(prefs.rowH)
  const [cursorDay, setCursorDay] = useState<number | null>(null)
  const [copyDialog, setCopyDialog] = useState<{ ids: string[] } | null>(null)
  const [filters, setFilters] = useState<GanttFilters>(EMPTY_FILTERS)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(query.get('task') ? [query.get('task')!] : []))
  const [primaryId, setPrimaryId] = useState<string | null>(query.get('task'))
  const [anchorId, setAnchorId] = useState<string | null>(query.get('task'))
  const [drawerOpen, setDrawerOpen] = useState(!!query.get('task'))
  const [menu, setMenu] = useState<{ id: string | null; x: number; y: number } | null>(null)
  const [baselineDialog, setBaselineDialog] = useState(false)
  const [baselineName, setBaselineName] = useState('')
  const [linkDialog, setLinkDialog] = useState<{ pred: string; succ: string } | null>(null)
  const [checkOpen, setCheckOpen] = useState(false)
  const [packageOpen, setPackageOpen] = useState(false)
  const [assistOpen, setAssistOpen] = useState<{ parentId: string | null; mode: 'ai' | 'import' } | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ view, ganttView, tableWidth, columns, showBaseline, rowH, companyDefaulted: true }))
    } catch {
      /* ignore */
    }
  }, [view, ganttView, tableWidth, columns, showBaseline, rowH])

  const sched = p.analysis?.current ?? null
  const groups = useMemo(() => ({ trades: org.trades.map((t) => ({ key: t.id, name: t.name, color: t.color })), sections: (p.bundle?.sections ?? []).map((s) => ({ key: s.id, name: s.name })) }), [org.trades, p.bundle?.sections])
  const rows = useMemo(() => (sched ? buildRows(p.plan.tasks, sched, collapsed, filters, p.today, ganttView, groups) : []), [p.plan.tasks, sched, collapsed, filters, p.today, ganttView, groups])
  const columnDefs = useMemo(() => ALL_COLUMNS.filter((c) => columns.includes(c.key)), [columns])

  const scale = useMemo(() => {
    const pxPerDay = VIEW_PX[view] * zoom
    const start = toDayNumber(p.ctx.projectStart)
    const end = Math.max(sched?.projectEnd ?? start, toDayNumber(p.bundle?.project.target_end_date ?? p.today), toDayNumber(p.today))
    return buildScale(start - 21, end + 45, pxPerDay)
  }, [view, zoom, p.ctx.projectStart, sched?.projectEnd, p.bundle?.project.target_end_date, p.today])

  const lookups = useMemo(
    () => ({ tradeName: org.tradeName, tradeColor: org.tradeColor, userName: org.userName, companyName: org.companyName, sectionName: (id: string | null) => p.bundle?.sections.find((s) => s.id === id)?.name ?? '' }),
    [org, p.bundle?.sections],
  )
  const floatFor = useCallback(
    (id: string) => {
      const s = sched?.tasks.get(id)
      const t = p.plan.tasks.find((x) => x.id === id)
      return s && t ? floatLabel(s, t.status) : ''
    },
    [sched, p.plan.tasks],
  )

  // ---- Auswahl (einfach, Strg = umschalten, Shift = Bereich)
  const onSelect = useCallback(
    (id: string | null, e: { ctrl: boolean; shift: boolean }) => {
      if (!id) {
        setSelectedIds(new Set())
        setPrimaryId(null)
        return
      }
      if (e.shift && anchorId) {
        const a = rows.findIndex((r) => r.task.id === anchorId)
        const b = rows.findIndex((r) => r.task.id === id)
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          setSelectedIds(new Set(rows.slice(lo, hi + 1).map((r) => r.task.id).filter((x) => !isVirtualId(x))))
          setPrimaryId(id)
          return
        }
      }
      if (e.ctrl) {
        setSelectedIds((s) => {
          const n = new Set(s)
          if (n.has(id)) n.delete(id)
          else n.add(id)
          return n
        })
        setPrimaryId(id)
        setAnchorId(id)
        return
      }
      setSelectedIds(new Set([id]))
      setPrimaryId(id)
      setAnchorId(id)
    },
    [rows, anchorId],
  )

  // ---- Vorgang zeigen: aus der Adresse (?task= mit Drawer, ?focus= ohne) oder live von Jarvis
  const [focusRequest, setFocusRequest] = useState<{ taskId: string; openDrawer: boolean; nonce: number; attempt: number } | null>(null)
  const [focus, setFocus] = useState<{ taskId: string; nonce: number } | null>(null)
  const [flashIds, setFlashIds] = useState<Set<string>>(() => new Set())
  const flashTimer = useRef<number | undefined>(undefined)
  const flash = useCallback((ids: string[]) => {
    window.clearTimeout(flashTimer.current)
    setFlashIds(new Set())
    // Kurz danach neu setzen, damit die Animation auch bei denselben Vorgängen erneut startet
    // (setTimeout statt requestAnimationFrame: läuft auch, wenn der Tab im Hintergrund ist)
    flashTimer.current = window.setTimeout(() => {
      setFlashIds(new Set(ids))
      flashTimer.current = window.setTimeout(() => setFlashIds(new Set()), 4000)
    }, 30)
  }, [])
  useEffect(() => () => window.clearTimeout(flashTimer.current), [])

  const qTask = query.get('task')
  const qFocus = query.get('focus')
  useEffect(() => {
    const id = qTask ?? qFocus
    if (id) setFocusRequest({ taskId: id, openDrawer: !!qTask, nonce: Date.now(), attempt: 0 })
  }, [qTask, qFocus])

  useEffect(() => {
    const projectId = p.projectId
    // Signal kam, während der Plan noch geladen wurde
    const recentFocus = jarvisBus.takeRecent('focus-task', projectId)
    if (recentFocus) setFocusRequest({ taskId: recentFocus.taskId, openDrawer: recentFocus.openDrawer, nonce: Date.now(), attempt: 0 })
    const recentHighlight = jarvisBus.takeRecent('highlight', projectId)
    if (recentHighlight) flash(recentHighlight.taskIds)
    const offFocus = jarvisBus.on('focus-task', (e) => {
      if (e.projectId !== projectId) return
      jarvisBus.takeRecent('focus-task', projectId)
      setFocusRequest({ taskId: e.taskId, openDrawer: e.openDrawer, nonce: Date.now(), attempt: 0 })
    })
    const offHighlight = jarvisBus.on('highlight', (e) => {
      if (e.projectId !== projectId) return
      jarvisBus.takeRecent('highlight', projectId)
      flash(e.taskIds)
    })
    return () => {
      offFocus()
      offHighlight()
    }
  }, [p.projectId, flash])

  useEffect(() => {
    const req = focusRequest
    if (!req) return
    const task = p.plan.tasks.find((t) => t.id === req.taskId)
    if (!task) {
      // z. B. gerade von Jarvis angelegt und noch nicht geladen - auf die nächsten Zeilen warten
      if (Date.now() - req.nonce > 6000) setFocusRequest(null)
      return
    }
    if (!rows.some((r) => r.task.id === req.taskId)) {
      if (req.attempt >= 2) return setFocusRequest(null)
      // Sichtbar machen: Filter zurücksetzen, Vorfahren bzw. Gruppe aufklappen - notfalls Gesamtansicht
      const byId = new Map(p.plan.tasks.map((t) => [t.id, t]))
      const reveal = new Set<string>([`grp:${ganttView}:${(ganttView === 'trade' ? task.trade_id : task.section_id) || 'none'}`])
      for (let cur = task.parent_id ? byId.get(task.parent_id) : undefined; cur; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) reveal.add(cur.id)
      setFilters(EMPTY_FILTERS)
      setCollapsed((c) => new Set([...c].filter((id) => !reveal.has(id))))
      if (req.attempt === 1) setGanttView('all')
      setFocusRequest({ ...req, attempt: req.attempt + 1 })
      return
    }
    setSelectedIds(new Set([req.taskId]))
    setPrimaryId(req.taskId)
    setAnchorId(req.taskId)
    if (req.openDrawer) setDrawerOpen(true)
    setFocus({ taskId: req.taskId, nonce: req.nonce })
    setFocusRequest(null)
  }, [focusRequest, rows, p.plan.tasks, ganttView])

  // Jarvis soll wissen, welcher Vorgang gerade ausgewählt ist („verschieb den hier …“)
  useEffect(() => {
    jarvisBus.setContext({ taskId: primaryId && !isVirtualId(primaryId) ? primaryId : null })
  }, [primaryId])
  useEffect(() => () => jarvisBus.setContext({ taskId: null }), [])

  // ---- Tastatur
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const idx = primaryId ? rows.findIndex((r) => r.task.id === primaryId) : -1
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        p.undo()
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault()
        p.redo()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = rows[Math.max(0, Math.min(rows.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))]
        if (next) onSelect(next.task.id, { ctrl: false, shift: e.shiftKey })
      } else if (e.key === 'ArrowRight' && idx >= 0 && rows[idx].hasChildren && rows[idx].collapsed) {
        setCollapsed((c) => { const n = new Set(c); n.delete(rows[idx].task.id); return n })
      } else if (e.key === 'ArrowLeft' && idx >= 0 && rows[idx].hasChildren && !rows[idx].collapsed) {
        setCollapsed((c) => new Set(c).add(rows[idx].task.id))
      } else if (e.key === 'Enter' && primaryId && !isVirtualId(primaryId)) {
        setDrawerOpen(true)
      } else if (e.key === 'Delete' && selectedIds.size && p.canEdit) {
        const ids = [...selectedIds].filter((x) => !isVirtualId(x))
        if (ids.length && confirm(ids.length === 1 ? `„${p.plan.tasks.find((t) => t.id === ids[0])?.name}“ löschen?` : `${ids.length} Vorgänge löschen?`)) {
          p.deleteTasks(ids)
          setSelectedIds(new Set())
          setPrimaryId(null)
        }
      } else if (e.key === 'Escape') {
        setDrawerOpen(false)
        setCheckOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p, primaryId, selectedIds, rows, onSelect])

  // ---- Änderungen: Nachfolger hängen mit dran - sofort mitverschieben, kein Bestätigungsdialog.
  // Ein kurzer Toast zeigt, was sich mitbewegt hat; die Historie hält die genaue Auswirkung fest.
  const withImpact = useCallback((description: string, impact: ops.ImpactAnalysis, commit: (cascade: boolean, reason: string) => void, notes: string[] = []) => {
    commit(true, '')
    if (impact.affected.length > 0) toast.push(`${impact.affected.length} Folgevorgang${impact.affected.length === 1 ? '' : '-e'} mitverschoben · Projektende ${formatDate(impact.newProjectEnd)}`, 'info')
    // Feiertagshinweis - die Engine hat das Ende bereits korrekt gesetzt
    if (notes.length) toast.push(notes.join(' '), 'info')
  }, [toast])
  // „In diesem Zeitraum liegt ein Feiertag …“ für den Zielzeitraum eines Vorgangs
  const spanNotes = useCallback((id: string, start: number, duration: number): string[] => {
    const s = sched?.tasks.get(id)
    if (!s || duration <= 0) return []
    try { return explainSpan(s.calendar, start, duration).sentences } catch { return [] }
  }, [sched])

  const onMove = useCallback(
    (id: string, newStart: ISODate) => {
      const t = p.plan.tasks.find((x) => x.id === id)
      if (!t) return
      withImpact(`„${t.name}“ auf ${formatDate(newStart)} verschieben.`, p.previewMove(id, newStart), (cascade, reason) => p.moveTask(id, newStart, cascade, reason || 'Vorgang verschoben'), spanNotes(id, toDayNumber(newStart), sched?.tasks.get(id)?.duration ?? t.duration))
    },
    [p, withImpact, spanNotes, sched],
  )
  const onMoveMany = useCallback(
    (ids: string[], shift: number) => {
      withImpact(`${ids.length} Vorgänge um ${Math.abs(shift)} Arbeitstage ${shift > 0 ? 'nach hinten' : 'nach vorn'} verschieben.`, p.previewMoveMany(ids, shift), (cascade, reason) => p.moveTasks(ids, shift, cascade, reason || `${ids.length} Vorgänge verschoben`))
    },
    [p, withImpact],
  )
  const onResizeEnd = useCallback(
    (id: string, newEnd: ISODate) => {
      const s = sched?.tasks.get(id)
      const t = p.plan.tasks.find((x) => x.id === id)
      if (!s || !t) return
      const dur = Math.max(1, s.calendar.countWorkdays(s.start, toDayNumber(newEnd)))
      withImpact(`Dauer von „${t.name}“ auf ${dur} Arbeitstage ändern (Ende ${formatDate(newEnd)}).`, p.previewDuration(id, dur), (cascade, reason) => p.setDuration(id, dur, cascade, reason || 'Dauer geändert'), spanNotes(id, s.start, dur))
    },
    [p, sched, withImpact, spanNotes],
  )
  const onResizeStart = useCallback(
    (id: string, newStart: ISODate) => {
      const s = sched?.tasks.get(id)
      if (!s) return
      const dur = Math.max(1, s.calendar.countWorkdays(toDayNumber(newStart), s.end))
      p.apply((st, c) => ops.moveTask(ops.setDuration(st, c, id, dur, true), c, id, newStart, true), 'Start geändert')
    },
    [p, sched],
  )
  const onLink = useCallback((pred: string, succ: string) => setLinkDialog({ pred, succ }), [])

  const onInlineEdit = useCallback(
    (task: Task, field: 'name' | 'duration' | 'start_date' | 'end_date' | 'progress' | 'responsible', value: string) => {
      switch (field) {
        case 'name':
          if (value.trim()) p.updateTask(task.id, { name: value.trim() }, 'Umbenannt')
          break
        case 'responsible': {
          // Freitext; passt der Name zu einem Teammitglied, wird zusätzlich der Benutzer verknüpft
          const member = org.members.find((m) => m.user?.name.toLowerCase() === value.trim().toLowerCase())
          p.updateTask(task.id, { responsible_name: value.trim(), responsible_user_id: member?.user_id ?? null }, 'Verantwortlicher geändert')
          break
        }
        case 'duration': {
          const d = Number(value)
          if (Number.isFinite(d) && d >= 1) withImpact(`Dauer von „${task.name}“ auf ${d} Arbeitstage ändern.`, p.previewDuration(task.id, d), (cascade, reason) => p.setDuration(task.id, d, cascade, reason || 'Dauer geändert'), spanNotes(task.id, sched?.tasks.get(task.id)?.start ?? toDayNumber(task.start_date), d))
          break
        }
        case 'start_date':
          if (/^\d{4}-\d{2}-\d{2}$/.test(value)) onMove(task.id, value)
          break
        case 'end_date':
          if (/^\d{4}-\d{2}-\d{2}$/.test(value)) onResizeEnd(task.id, value)
          break
        case 'progress': {
          const n = Number(value)
          if (Number.isFinite(n)) p.updateTask(task.id, { progress: Math.max(0, Math.min(100, Math.round(n))) }, 'Fortschritt gemeldet')
          break
        }
      }
    },
    [p, onMove, onResizeEnd, withImpact, spanNotes, sched, org.members],
  )

  // ---- Anlegen
  const addTask = useCallback(
    (kind: 'task' | 'phase' | 'milestone', relativeTo?: string | null, asChild = false) => {
      const ref = relativeTo && !isVirtualId(relativeTo) ? p.plan.tasks.find((t) => t.id === relativeTo) : null
      const id = p.newId(kind === 'milestone' ? 'ms' : kind === 'phase' ? 'ph' : 't')
      const name = kind === 'phase' ? 'Neue Phase' : kind === 'milestone' ? 'Neuer Meilenstein' : 'Neuer Vorgang'
      const last = rows.filter((r) => !r.virtual).at(-1)?.task ?? null
      const parent_id = asChild && ref ? ref.id : ref ? ref.parent_id : kind === 'phase' ? null : (last?.parent_id ?? null)
      const input = { id, name, type: kind, parent_id, after_id: asChild ? null : ref?.id ?? null, duration: kind === 'milestone' ? 0 : 5, trade_id: ref?.trade_id ?? null, section_id: ref?.section_id ?? null }
      // Keine automatische Verknüpfung: Abhängigkeiten werden bewusst nachträglich gesetzt
      p.createTask({ ...input, start_date: ref && !asChild ? ref.start_date : undefined })

      if (asChild && ref) setCollapsed((c) => { const n = new Set(c); n.delete(ref.id); return n })
      onSelect(id, { ctrl: false, shift: false })
      setDrawerOpen(true)
    },
    [p, rows, onSelect],
  )

  const exportCsv = () => {
    if (!p.bundle) return
    downloadCsv(`terminplan-${p.bundle.project.number || p.projectId}.csv`, ['#', 'Vorgang', 'Ebene', 'Kategorie', 'Firma', 'Abschnitt', 'Start', 'Ende', 'Dauer', 'Fortschritt', 'Status', 'Vorgänger', 'Spielraum', 'Kritisch'],
      ops.flattenTree(p.plan.tasks).map((f, i) => [String(i + 1), f.task.name, String(f.depth), org.tradeName(f.task.trade_id), org.companyName(f.task.company_id), lookups.sectionName(f.task.section_id), formatDate(f.task.start_date), formatDate(f.task.end_date), String(f.task.duration), String(f.task.progress), TASK_STATUS_LABELS[f.task.status], p.plan.dependencies.filter((d) => d.successor_id === f.task.id).map((d) => `${p.plan.tasks.find((t) => t.id === d.predecessor_id)?.name ?? ''} ${d.type}${d.lag_days ? (d.lag_days > 0 ? '+' : '') + d.lag_days : ''}`).join(' | '), String(f.task.total_float), f.task.is_critical ? 'ja' : '']))
  }

  const menuItems = useMemo<MenuItem[]>(() => {
    if (!menu) return []
    const id = menu.id
    const t = id ? p.plan.tasks.find((x) => x.id === id) : null
    if (!t) {
      return [
        { label: 'Vorgang hinzufügen', icon: <Plus size={14} />, onClick: () => addTask('task') },
        { label: 'Phase hinzufügen', icon: <Layers size={14} />, onClick: () => addTask('phase') },
        { label: 'Meilenstein hinzufügen', icon: <Flag size={14} />, onClick: () => addTask('milestone') },
        { label: 'Arbeitspaket einfügen …', icon: <Package size={14} />, onClick: () => setPackageOpen(true) },
        { label: 'Mit KI erweitern …', icon: <Sparkles size={14} />, onClick: () => setAssistOpen({ parentId: null, mode: 'ai' }) },
        { label: 'Importieren …', icon: <FileUp size={14} />, onClick: () => setAssistOpen({ parentId: null, mode: 'import' }) },
        { separator: true, label: '' },
        { label: 'Ganzen Plan als neues Projekt …', icon: <FolderPlus size={14} />, onClick: () => setCopyDialog({ ids: [] }) },
      ]
    }
    const ro = !p.canEdit
    const multi = selectedIds.size > 1
    return [
      { label: 'Bearbeiten', icon: <Pencil size={14} />, onClick: () => { setPrimaryId(t.id); setDrawerOpen(true) }, shortcut: 'Enter' },
      { label: 'Warum dieser Termin?', icon: <HelpCircle size={14} />, onClick: () => { setPrimaryId(t.id); setDrawerOpen(true) } },
      { separator: true, label: '' },
      { label: 'Vorgang danach einfügen', icon: <Plus size={14} />, onClick: () => addTask('task', t.id), disabled: ro },
      { label: 'Untervorgang hinzufügen', icon: <Indent size={14} />, onClick: () => addTask('task', t.id, true), disabled: ro || t.type === 'milestone' },
      { label: 'Meilenstein hinzufügen', icon: <Diamond size={14} />, onClick: () => addTask('milestone', t.id), disabled: ro },
      { label: 'Mit KI erweitern … (wird zur Phase)', icon: <Sparkles size={14} />, onClick: () => setAssistOpen({ parentId: t.id, mode: 'ai' }), disabled: ro || t.type === 'milestone' },
      { label: 'Importieren … (wird zur Phase)', icon: <FileUp size={14} />, onClick: () => setAssistOpen({ parentId: t.id, mode: 'import' }), disabled: ro || t.type === 'milestone' },
      { label: 'Duplizieren', icon: <Copy size={14} />, onClick: () => p.duplicateTask(t.id), disabled: ro },
      { label: multi ? `${selectedIds.size} Vorgänge als neues Projekt …` : 'Als neues Projekt kopieren …', icon: <FolderPlus size={14} />, onClick: () => setCopyDialog({ ids: multi ? [...selectedIds].filter((x) => !isVirtualId(x)) : [t.id] }) },
      { separator: true, label: '' },
      { label: 'Abhängigkeit erstellen …', icon: <Link2 size={14} />, onClick: () => setLinkDialog({ pred: t.id, succ: '' }), disabled: ro },
      { label: multi ? `${selectedIds.size} Vorgänge verschieben …` : 'Verschieben …', icon: <MoveHorizontal size={14} />, disabled: ro, onClick: () => {
        if (multi) { const v = prompt('Um wie viele Arbeitstage verschieben? (negativ = nach vorn)', '5'); const n = Number(v); if (v && Number.isFinite(n) && n !== 0) onMoveMany([...selectedIds].filter((x) => !isVirtualId(x)), n) }
        else { const v = prompt('Neuer Start (JJJJ-MM-TT):', t.start_date); if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) onMove(t.id, v) }
      } },
      { label: 'Automatische Planung wiederherstellen', icon: <Unlock size={14} />, onClick: () => p.releaseConstraint(t.id), disabled: ro || (t.constraint_type === 'asap' && t.scheduling_mode === 'auto') },
      { separator: true, label: '' },
      { label: 'Einrücken', icon: <Indent size={14} />, onClick: () => p.indent(t.id), disabled: ro },
      { label: 'Ausrücken', icon: <Outdent size={14} />, onClick: () => p.outdent(t.id), disabled: ro || !t.parent_id },
      { label: 'Nach oben', icon: <ArrowUp size={14} />, onClick: () => p.moveInTree(t.id, 'up'), disabled: ro },
      { label: 'Nach unten', icon: <ArrowDown size={14} />, onClick: () => p.moveInTree(t.id, 'down'), disabled: ro },
      { separator: true, label: '' },
      { label: multi ? `${selectedIds.size} Vorgänge löschen` : 'Löschen', icon: <Trash2 size={14} />, danger: true, disabled: ro, onClick: () => {
        const ids = multi ? [...selectedIds].filter((x) => !isVirtualId(x)) : [t.id]
        if (confirm(ids.length === 1 ? `„${t.name}“ löschen?` : `${ids.length} Vorgänge löschen?`)) { p.deleteTasks(ids); setSelectedIds(new Set()); setPrimaryId(null) }
      } },
    ]
  }, [menu, p, addTask, onMove, onMoveMany, selectedIds])

  if (p.loading && !p.bundle) return <Spinner label="Terminplan wird geladen …" />
  if (p.error) return <div className="p-6"><ErrorBox message={p.error} onRetry={p.reload} /></div>
  if (!sched || !p.bundle) return null

  const parents = new Set(p.plan.tasks.filter((t) => t.parent_id).map((t) => t.parent_id!))
  const drawerTask = primaryId && !isVirtualId(primaryId) && p.plan.tasks.some((t) => t.id === primaryId) ? primaryId : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <GanttToolbar
        view={view}
        onView={(v) => { setView(v); setZoom(1) }}
        ganttView={ganttView}
        onGanttView={(v) => { setGanttView(v); setCollapsed(new Set()) }}
        onZoom={(dir) => setZoom((z) => Math.max(0.4, Math.min(3, z * (dir > 0 ? 1.25 : 0.8))))}
        onRowHeight={(dir) => setRowH((h) => { const i = ROW_HEIGHTS.indexOf(h as (typeof ROW_HEIGHTS)[number]); const n = ROW_HEIGHTS[Math.max(0, Math.min(ROW_HEIGHTS.length - 1, (i < 0 ? 1 : i) + dir))]; return n })}
        filters={filters}
        onFilters={setFilters}
        sections={p.bundle.sections}
        showBaseline={showBaseline}
        onShowBaseline={setShowBaseline}
        hasBaseline={!!p.analysis?.activeBaseline}
        columns={columns}
        onColumns={setColumns}
        canUndo={p.canUndo}
        canRedo={p.canRedo}
        onUndo={p.undo}
        onRedo={p.redo}
        onAdd={(k) => addTask(k, primaryId)}
        onInsertPackage={() => setPackageOpen(true)}
        onInsertAssist={(mode) => setAssistOpen({ parentId: primaryId && !isVirtualId(primaryId) ? primaryId : null, mode })}
        onExpandAll={() => setCollapsed(new Set())}
        onCollapseAll={() => setCollapsed(new Set(ganttView === 'all' || ganttView === 'phase' ? parents : rows.filter((r) => r.virtual).map((r) => r.task.id)))}
        onSaveBaseline={() => { setBaselineName(`Baseline ${(p.bundle?.baselines.length ?? 0) + 1} – ${formatDate(p.today)}`); setBaselineDialog(true) }}
        onScenario={() => navigate(`/projects/${p.projectId}/scenarios`)}
        onCheck={() => setCheckOpen((o) => !o)}
        onExport={(kind) => (kind === 'csv' ? exportCsv() : api.reports.open(p.projectId, 'schedule').catch((e) => toast.push(e.message, 'error')))}
        readOnly={!p.canEdit}
        saving={p.saving}
        dirty={p.dirty}
        scenarioName={p.mode.kind === 'scenario' ? p.mode.scenario.name : undefined}
        selectionCount={selectedIds.size}
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <GanttChart
            rows={rows}
            sched={sched}
            dependencies={p.plan.dependencies}
            baselineTasks={p.analysis?.baselineTasks ?? new Map()}
            showBaseline={showBaseline}
            scale={scale}
            today={p.today}
            selectedIds={selectedIds}
            primaryId={primaryId}
            readOnly={!p.canEdit}
            lookups={lookups}
            tableWidth={tableWidth}
            columns={columnDefs}
            rowH={rowH}
            cursorDay={cursorDay}
            focus={focus}
            flashIds={flashIds}
            onCursorDay={setCursorDay}
            floatLabel={floatFor}
            onTableWidth={setTableWidth}
            onSelect={onSelect}
            onToggleCollapse={(id) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n })}
            onOpen={(id) => { onSelect(id, { ctrl: false, shift: false }); setDrawerOpen(true) }}
            onContextMenu={(id, x, y) => setMenu({ id, x, y })}
            onMove={onMove}
            onMoveMany={onMoveMany}
            onResizeStart={onResizeStart}
            onResizeEnd={onResizeEnd}
            onLink={onLink}
            onInlineEdit={onInlineEdit}
          />
        </div>
        {checkOpen && (
          <div className="no-print hidden w-[360px] shrink-0 lg:block">
            <PlanCheckPanel onClose={() => setCheckOpen(false)} onOpenTask={(id) => { onSelect(id, { ctrl: false, shift: false }); setDrawerOpen(true) }} />
          </div>
        )}
        {drawerOpen && drawerTask && (
          <div className="no-print hidden w-[400px] shrink-0 lg:block">
            <TaskDrawer taskId={drawerTask} onClose={() => setDrawerOpen(false)} />
          </div>
        )}
      </div>
      {drawerOpen && drawerTask && (
        <div className="fixed inset-0 z-40 bg-ink/30 lg:hidden" onClick={() => setDrawerOpen(false)}>
          <div className="absolute inset-y-0 right-0 w-[92vw] max-w-md" onClick={(e) => e.stopPropagation()}>
            <TaskDrawer taskId={drawerTask} onClose={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      <Modal open={baselineDialog} onClose={() => setBaselineDialog(false)} title="Plan freigeben / Baseline erstellen" width="sm"
        footer={<><Button variant="ghost" onClick={() => setBaselineDialog(false)}>Abbrechen</Button><Button variant="primary" onClick={async () => { try { await p.saveBaseline(baselineName); toast.push('Baseline gespeichert.', 'success'); setBaselineDialog(false) } catch (e) { toast.push((e as Error).message, 'error') } }}>Einfrieren</Button></>}>
        <p className="mb-3 text-sm text-ink-soft">Der aktuelle Terminstand wird vollständig eingefroren. Spätere Änderungen werden als Abweichung gegen diese Baseline ausgewiesen. Mehrere Baselines sind möglich (z. B. „Auftrag“, „Ausführungsfreigabe“).</p>
        <Field label="Bezeichnung"><Input value={baselineName} onChange={(e) => setBaselineName(e.target.value)} autoFocus /></Field>
      </Modal>

      <LinkDialog link={linkDialog} tasks={p.plan.tasks} onClose={() => setLinkDialog(null)} onCreate={(pred, succ, type, lag, newTask) => {
        if (newTask) {
          // Neuen Vorgang anlegen und direkt verbinden (eine Historie-Aktion)
          const id = p.newId('t')
          const ref = p.plan.tasks.find((t) => t.id === (newTask.role === 'succ' ? pred : succ))!
          p.apply((st, c) => {
            const created = ops.createTask(st, c, { id, name: newTask.name, type: 'task', parent_id: ref.parent_id, after_id: newTask.role === 'succ' ? ref.id : null, duration: newTask.duration, trade_id: ref.trade_id, section_id: ref.section_id })
            return ops.addDependency(created, c, { id: p.newId('dep'), predecessor_id: newTask.role === 'succ' ? pred : id, successor_id: newTask.role === 'succ' ? id : succ, type, lag_days: lag }).state
          }, `Vorgang „${newTask.name}“ angelegt und verknüpft`)
          onSelect(id, { ctrl: false, shift: false })
        } else p.addDependency(pred, succ, type, lag)
        setLinkDialog(null)
      }} />
      {copyDialog && <CopyProjectDialog ids={copyDialog.ids} onClose={() => setCopyDialog(null)} />}
      {packageOpen && <WorkPackageDialog defaultParentId={primaryId && !isVirtualId(primaryId) ? (p.plan.tasks.find((t) => t.id === primaryId)?.parent_id ?? null) : null} onClose={() => setPackageOpen(false)} />}
      {assistOpen && <PlanAssistDialog initialParentId={assistOpen.parentId} mode={assistOpen.mode} onClose={() => setAssistOpen(null)} />}
    </div>
  )
}

function LinkDialog({ link, tasks, onClose, onCreate }: { link: { pred: string; succ: string } | null; tasks: Task[]; onClose: () => void; onCreate: (pred: string, succ: string, type: 'FS' | 'SS' | 'FF' | 'SF', lag: number, newTask?: { name: string; duration: number; role: 'succ' | 'pred' }) => void }) {
  const [other, setOther] = useState('')
  const [role, setRole] = useState<'pred' | 'succ'>('pred') // Rolle des angeklickten Vorgangs
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [newName, setNewName] = useState('')
  const [newDuration, setNewDuration] = useState(5)
  const [type, setType] = useState<'FS' | 'SS' | 'FF' | 'SF'>('FS')
  const [lag, setLag] = useState(0)
  const [advanced, setAdvanced] = useState(false)
  useEffect(() => {
    setOther(link?.succ ?? '')
    setRole('pred')
    setMode(link?.succ ? 'existing' : 'existing')
    setNewName('')
    setNewDuration(5)
    setType('FS')
    setLag(0)
    setAdvanced(false)
  }, [link])
  if (!link) return null
  const me = tasks.find((t) => t.id === link.pred)
  const flat = ops.flattenTree(tasks).filter((f) => f.task.id !== link.pred)
  const first = role === 'pred' ? me?.name : mode === 'new' ? newName || 'neuer Vorgang' : (tasks.find((t) => t.id === other)?.name ?? '…')
  const simple: { value: 'FS' | 'SS' | 'FF'; label: string }[] = [
    { value: 'FS', label: `Wenn „${first}“ fertig ist` },
    { value: 'SS', label: `Wenn „${first}“ beginnt` },
    { value: 'FF', label: 'Beide sollen ungefähr gleichzeitig fertig werden' },
  ]
  const valid = mode === 'new' ? newName.trim().length > 0 : !!other
  const submit = () => {
    if (!valid) return
    if (mode === 'new') onCreate(role === 'pred' ? link.pred : '', role === 'pred' ? '' : link.pred, type, lag, { name: newName.trim(), duration: Math.max(1, newDuration), role: role === 'pred' ? 'succ' : 'pred' })
    else if (role === 'pred') onCreate(link.pred, other, type, lag)
    else onCreate(other, link.pred, type, lag)
  }
  return (
    <Modal open onClose={onClose} title="Abhängigkeit erstellen" width="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Abbrechen</Button><Button variant="primary" disabled={!valid} onClick={submit}>{mode === 'new' ? 'Anlegen & verbinden' : 'Verbinden'}</Button></>}>
      <div className="space-y-3">
        <Field label={`„${me?.name}“ ist …`}>
          <div className="flex gap-2">
            {(['pred', 'succ'] as const).map((r) => (
              <label key={r} className={`flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${role === r ? 'border-brand bg-brand-soft/40' : 'border-line'}`}>
                <input type="radio" name="linkrole" className="accent-brand" checked={role === r} onChange={() => setRole(r)} />{r === 'pred' ? 'der Vorgänger (davor)' : 'der Nachfolger (danach)'}
              </label>
            ))}
          </div>
        </Field>
        <Field label={role === 'pred' ? 'Nachfolger' : 'Vorgänger'}>
          <div className="mb-2 flex gap-2 text-xs">
            <button type="button" className={`rounded-md border px-2 py-1 ${mode === 'existing' ? 'border-brand bg-brand-soft/40' : 'border-line'}`} onClick={() => setMode('existing')}>Bestehenden Vorgang wählen</button>
            <button type="button" className={`rounded-md border px-2 py-1 ${mode === 'new' ? 'border-brand bg-brand-soft/40' : 'border-line'}`} onClick={() => setMode('new')}>Neuen Vorgang eintragen</button>
          </div>
          {mode === 'existing' ? (
            <select value={other} onChange={(e) => setOther(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm" autoFocus>
              <option value="">– auswählen –</option>
              {flat.map((f) => <option key={f.task.id} value={f.task.id}>{' '.repeat(f.depth * 2)}{f.task.name}</option>)}
            </select>
          ) : (
            <div className="grid grid-cols-[1fr_90px] gap-2">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Bezeichnung des neuen Vorgangs" autoFocus onKeyDown={(e) => e.key === 'Enter' && submit()} />
              <Input type="number" min={1} value={newDuration} onChange={(e) => setNewDuration(Number(e.target.value) || 1)} title="Dauer in Arbeitstagen" />
            </div>
          )}
        </Field>
        <div>
          <div className="mb-1 text-xs font-medium text-ink-soft">Wann darf die nächste Arbeit beginnen?</div>
          <div className="space-y-1">
            {simple.map((s) => (
              <label key={s.value} className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${type === s.value ? 'border-brand bg-brand-soft/40' : 'border-line'}`}>
                <input type="radio" name="linktype" className="accent-brand" checked={type === s.value} onChange={() => setType(s.value)} />{s.label}
              </label>
            ))}
          </div>
          <button type="button" className="mt-1 text-xs text-brand hover:underline" onClick={() => setAdvanced((a) => !a)}>{advanced ? 'Einfache Auswahl' : 'Erweiterte Einstellung'}</button>
          {advanced && (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Field label="Beziehungstyp"><select value={type} onChange={(e) => setType(e.target.value as 'FS')} className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm"><option value="FS">Ende → Anfang (FS)</option><option value="SS">Anfang → Anfang (SS)</option><option value="FF">Ende → Ende (FF)</option><option value="SF">Anfang → Ende (SF)</option></select></Field>
              <Field label="Lag / Lead (AT)" hint="negativ = Vorlauf"><Input type="number" value={lag} onChange={(e) => setLag(Number(e.target.value) || 0)} /></Field>
            </div>
          )}
          {!advanced && <Field label="Wartezeit danach (Arbeitstage)" hint="z. B. 3 = beginnt 3 Arbeitstage nach Abschluss (Trocknung)" className="mt-2"><Input type="number" min={0} value={lag} onChange={(e) => setLag(Number(e.target.value) || 0)} /></Field>}
        </div>
      </div>
    </Modal>
  )
}

/** Ganzen Plan oder ausgewählte Vorgänge als neues Projekt anlegen */
function CopyProjectDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const p = useProject()
  const toast = useToast()
  const [name, setName] = useState(`${p.bundle?.project.name ?? 'Projekt'} (Kopie)`)
  const [number, setNumber] = useState('')
  const [start, setStart] = useState(p.bundle?.project.start_date ?? p.today)
  const [reset, setReset] = useState(true)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const np = await api.projects.duplicate(p.projectId, { name, number, start_date: start, task_ids: ids.length ? ids : undefined, reset_progress: reset })
      toast.push('Neues Projekt angelegt.', 'success')
      navigate(`/projects/${np.id}/gantt`)
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={ids.length ? `${ids.length} Vorgänge als neues Projekt` : 'Ganzen Plan als neues Projekt'} width="sm" footer={<><Button variant="ghost" onClick={onClose}>Abbrechen</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={run}>Projekt anlegen</Button></>}>
      <div className="space-y-3">
        <Field label="Projektname" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Projektnummer"><Input value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
          <Field label="Neuer Projektstart" hint="Termine werden relativ verschoben"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-brand" checked={reset} onChange={(e) => setReset(e.target.checked)} /> Fortschritt und Ist-Termine zurücksetzen</label>
        <p className="text-xs text-ink-faint">{ids.length ? 'Ausgewählte Vorgänge inkl. Untervorgängen und übergeordneten Phasen; Abhängigkeiten innerhalb der Auswahl bleiben erhalten.' : 'Alle Phasen, Vorgänge, Abhängigkeiten, Voraussetzungen und Abschnitte werden kopiert.'}</p>
      </div>
    </Modal>
  )
}
