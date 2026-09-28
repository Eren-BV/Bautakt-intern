/**
 * Zustand eines geöffneten Projekts. Der Client hält den vollständigen Plan, rechnet
 * mit der shared Engine sofort neu (Gantt reagiert ohne Roundtrip) und persistiert
 * gebündelt (debounced) über PUT /plan. Undo/Redo arbeitet auf Plan-Snapshots.
 *
 * Optimistisches Locking: jeder Speichervorgang sendet die erwartete Version; bei
 * Konflikt (409) wird neu geladen und der Nutzer informiert.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Baseline, ISODate, Project, ProjectBundle, Scenario, SiteUpdateRequest, Task, TaskDependency, DependencyType, ChangeSource } from '../../shared/types'
import { explainTask, type TaskExplanation } from '../../shared/engine/explain'
import { taskReadiness, type Readiness } from '../../shared/engine/readiness'
import type { ImpactAnalysis, NewTaskInput, PlanContext, PlanState } from '../../shared/engine/operations'
import * as ops from '../../shared/engine/operations'
import { analyzeProject, type ProjectAnalysis } from '../../shared/engine/analysis'
import { todayISO } from '../../shared/engine/dates'
import { api, ApiError } from '../lib/api'
import { useRealtimeChannel } from '../lib/realtime'
import * as jarvisBus from '../jarvis/bus'
import { useToast } from './toast'
import { useAuth } from './auth'

export type PlanMode = { kind: 'plan' } | { kind: 'scenario'; scenario: Scenario }

export interface ProjectStore {
  projectId: string
  bundle: ProjectBundle | null
  loading: boolean
  error: string | null
  plan: PlanState
  ctx: PlanContext
  analysis: ProjectAnalysis | null
  mode: PlanMode
  saving: boolean
  dirty: boolean
  canEdit: boolean
  canUndo: boolean
  canRedo: boolean
  today: ISODate
  reload(): Promise<void>
  undo(): void
  redo(): void
  /** Generische Änderung mit Undo-Eintrag und Speicherung */
  apply(fn: (state: PlanState, ctx: PlanContext) => PlanState, reason?: string, source?: ChangeSource): void
  /** Nur Stammdaten des Bundles (Voraussetzungen, Abschnitte, Zuweisungen, Baselines) neu laden - Plan bleibt */
  reloadMeta(): Promise<void>
  explain(taskId: string): TaskExplanation | null
  readiness(taskId: string): Readiness | null
  moveTasks(ids: string[], shiftWorkdays: number, cascade: boolean, reason?: string): void
  previewMoveMany(ids: string[], shiftWorkdays: number): ImpactAnalysis
  previewMove(taskId: string, newStart: ISODate): ImpactAnalysis
  previewDuration(taskId: string, duration: number): ImpactAnalysis
  moveTask(taskId: string, newStart: ISODate, cascade: boolean, reason?: string): void
  setDuration(taskId: string, duration: number, cascade?: boolean, reason?: string): void
  setStart(taskId: string, start: ISODate, cascade?: boolean, reason?: string): void
  setEnd(taskId: string, end: ISODate, cascade?: boolean, reason?: string): void
  updateTask(taskId: string, patch: Partial<Task>, reason?: string): void
  createTask(input: NewTaskInput, reason?: string): void
  deleteTasks(ids: string[]): void
  duplicateTask(id: string): void
  indent(id: string): void
  outdent(id: string): void
  moveInTree(id: string, dir: 'up' | 'down'): void
  addDependency(pred: string, succ: string, type?: DependencyType, lag?: number): string | null
  updateDependency(id: string, patch: Partial<Pick<TaskDependency, 'type' | 'lag_days'>>): void
  removeDependency(id: string): void
  releaseConstraint(id: string): void
  saveBaseline(name: string): Promise<Baseline>
  siteUpdate(taskId: string, req: SiteUpdateRequest): Promise<void>
  updateProject(patch: Partial<Project>): Promise<void>
  enterScenario(scenario: Scenario): void
  exitScenario(): void
  newId(prefix?: string): string
}

const ProjectContext = createContext<ProjectStore | null>(null)

export function newClientId(prefix = 't'): string {
  const rnd = crypto.getRandomValues(new Uint8Array(9))
  return `${prefix}_${btoa(String.fromCharCode(...rnd)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!)}`
}

const EMPTY_PLAN: PlanState = { tasks: [], dependencies: [] }

export function ProjectProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const toast = useToast()
  const auth = useAuth()
  const [bundle, setBundle] = useState<ProjectBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<PlanState>(EMPTY_PLAN)
  const [mode, setMode] = useState<PlanMode>({ kind: 'plan' })
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [, bump] = useState(0)
  const today = todayISO()

  const undoStack = useRef<PlanState[]>([])
  const redoStack = useRef<PlanState[]>([])
  const versionRef = useRef(0)
  const planRef = useRef(plan)
  planRef.current = plan
  const modeRef = useRef(mode)
  modeRef.current = mode
  const saveTimer = useRef<number | null>(null)
  const pendingReason = useRef<string>('')
  const pendingSource = useRef<ChangeSource>('MANUAL')
  const savingRef = useRef(false)
  const needsSave = useRef(false)
  const dirtyRef = useRef(false)
  /** Version, auf die nach dem laufenden Speichern neu geladen werden soll */
  const pendingReload = useRef(0)
  /** Version, auf die gerade neu geladen wird (verhindert doppeltes Laden: Realtime + Jarvis) */
  const reloadTarget = useRef(0)

  const ctx = useMemo<PlanContext>(
    () => ({
      projectId,
      projectStart: bundle?.project.start_date ?? today,
      projectCalendarId: bundle?.project.calendar_id ?? null,
      calendars: bundle?.calendars ?? [],
      exceptions: bundle?.exceptions ?? [],
      holidayRegion: bundle?.project.holiday_region ?? null,
      resources: bundle?.resources ?? [],
      today,
    }),
    [projectId, bundle, today],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const b = await api.projects.get(projectId)
      setBundle(b)
      versionRef.current = b.project.version
      try {
        localStorage.setItem('bautakt.lastProject', projectId)
      } catch {
        /* ignore */
      }
      const c: PlanContext = { projectId, projectStart: b.project.start_date, projectCalendarId: b.project.calendar_id, calendars: b.calendars, exceptions: b.exceptions, holidayRegion: b.project.holiday_region, resources: b.resources, today }
      setPlan(ops.recompute({ tasks: b.tasks, dependencies: b.dependencies }, c).state)
      undoStack.current = []
      redoStack.current = []
      setDirty(false)
      dirtyRef.current = false
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [projectId, today])

  /** Neu laden, wenn es eine neuere Planversion gibt - aber nie über ungespeicherte eigene Änderungen. */
  const reloadIfNewer = useCallback(
    (version: number) => {
      if (modeRef.current.kind === 'scenario') return
      if (version <= versionRef.current || version <= reloadTarget.current) return
      if (saveTimer.current || savingRef.current || dirtyRef.current) {
        pendingReload.current = Math.max(pendingReload.current, version)
        return
      }
      reloadTarget.current = version
      void load().finally(() => {
        reloadTarget.current = 0
      })
    },
    [load],
  )

  useEffect(() => {
    void load()
  }, [load])

  /** Nur Stammdaten des Bundles neu laden (Baselines, Voraussetzungen …) - Plan und Undo bleiben. */
  const reloadMeta = useCallback(async () => {
    const b = await api.projects.get(projectId)
    setBundle((prev) => (prev ? { ...b, tasks: prev.tasks, dependencies: prev.dependencies } : b))
  }, [projectId])

  // Live-Update bei Änderungen anderer Nutzer (oder von Jarvis) am selben Projekt:
  // - das Echo des eigenen Speicherns trägt keine neuere Version → ignorieren (sonst ginge Undo verloren)
  // - in der Szenario-Ansicht nicht den Masterplan einblenden; exitScenario() lädt ohnehin neu
  // - bei ungespeicherten eigenen Änderungen erst nach dem Speichern laden; den Konflikt fängt der 409-Pfad in flush()
  useRealtimeChannel(`project:${projectId}`, (evt) => {
    if (modeRef.current.kind === 'scenario') return
    if (evt.kind === 'baseline') {
      void reloadMeta()
      return
    }
    if (evt.kind !== 'plan') return
    reloadIfNewer(typeof evt.version === 'number' ? evt.version : Number.MAX_SAFE_INTEGER)
  })

  // Jarvis hat den Plan geändert (kommt meist vor dem Realtime-Signal an)
  useEffect(
    () =>
      jarvisBus.on('reload-project', (e) => {
        if (e.projectId === projectId) reloadIfNewer(e.version)
      }),
    [projectId, reloadIfNewer],
  )

  // Jarvis soll wissen, welches Projekt offen ist
  useEffect(() => {
    jarvisBus.setContext({ projectId, taskId: null })
    return () => {
      if (jarvisBus.getContext().projectId === projectId) jarvisBus.setContext({ projectId: null, taskId: null })
    }
  }, [projectId])

  // ---- Persistenz (debounced, sequenziell)
  const flush = useCallback(async () => {
    if (savingRef.current) {
      needsSave.current = true
      return
    }
    savingRef.current = true
    setSaving(true)
    const current = planRef.current
    const reason = pendingReason.current
    const source = pendingSource.current
    pendingReason.current = ''
    pendingSource.current = 'MANUAL'
    try {
      const m = modeRef.current
      if (m.kind === 'scenario') {
        await api.projects.updateScenario(projectId, m.scenario.id, { tasks: current.tasks, dependencies: current.dependencies })
      } else {
        const res = await api.projects.savePlan(projectId, { expected_version: versionRef.current, tasks: current.tasks, dependencies: current.dependencies, reason, source })
        versionRef.current = res.version
      }
      setDirty(false)
      dirtyRef.current = false
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.push(e.message, 'error')
        pendingReload.current = 0
        await load()
      } else {
        toast.push(`Speichern fehlgeschlagen: ${(e as Error).message}`, 'error')
      }
    } finally {
      savingRef.current = false
      setSaving(false)
      if (needsSave.current) {
        needsSave.current = false
        void flush()
      } else if (pendingReload.current) {
        // Während des Speicherns kam eine neuere Version (z. B. von Jarvis) - jetzt nachladen
        const version = pendingReload.current
        pendingReload.current = 0
        reloadIfNewer(version)
      }
    }
  }, [projectId, load, reloadIfNewer, toast])

  const scheduleSave = useCallback(() => {
    setDirty(true)
    dirtyRef.current = true
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      void flush()
    }, 500)
  }, [flush])

  // Vor jeder Jarvis-Runde: eigene, noch ausstehende Änderungen sofort speichern
  useEffect(
    () =>
      jarvisBus.registerFlush(async () => {
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current)
          saveTimer.current = null
          void flush()
        }
        while (savingRef.current) await new Promise((r) => setTimeout(r, 50))
      }),
    [flush],
  )

  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (saveTimer.current || savingRef.current) {
        e.preventDefault()
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current)
          void flush()
        }
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [flush])

  const canEdit = auth.can('plan.edit')

  const apply = useCallback(
    (fn: (state: PlanState, c: PlanContext) => PlanState, reason = '', source: ChangeSource = 'MANUAL') => {
      if (!canEdit) {
        toast.push('Keine Berechtigung zum Bearbeiten des Plans.', 'error')
        return
      }
      const before = planRef.current
      const after = fn(before, ctx)
      if (after === before) return
      undoStack.current.push(before)
      if (undoStack.current.length > 100) undoStack.current.shift()
      redoStack.current = []
      planRef.current = after
      setPlan(after)
      if (reason) pendingReason.current = [pendingReason.current, reason].filter(Boolean).join('; ')
      if (source !== 'MANUAL') pendingSource.current = source
      scheduleSave()
    },
    [ctx, scheduleSave, canEdit, toast],
  )

  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push(planRef.current)
    planRef.current = prev
    setPlan(prev)
    pendingReason.current = 'Rückgängig'
    scheduleSave()
    bump((x) => x + 1)
  }, [scheduleSave])
  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(planRef.current)
    planRef.current = next
    setPlan(next)
    pendingReason.current = 'Wiederholen'
    scheduleSave()
    bump((x) => x + 1)
  }, [scheduleSave])

  const analysis = useMemo<ProjectAnalysis | null>(() => {
    if (!bundle) return null
    return analyzeProject({ ...bundle, tasks: plan.tasks, dependencies: plan.dependencies }, today)
  }, [bundle, plan, today])

  const store = useMemo<ProjectStore>(() => {
    const previewWith = (mut: (s: PlanState) => PlanState, id: string) => ops.analyzeImpact(planRef.current, mut(planRef.current), ctx, [id])
    return {
      projectId,
      bundle,
      loading,
      error,
      plan,
      ctx,
      analysis,
      mode,
      saving,
      dirty,
      canEdit,
      canUndo: undoStack.current.length > 0,
      canRedo: redoStack.current.length > 0,
      today,
      reload: load,
      reloadMeta,
      explain: (id) => (analysis ? explainTask(id, plan.tasks, plan.dependencies, analysis.current) : null),
      readiness: (id) => {
        const t = plan.tasks.find((x) => x.id === id)
        return t && bundle ? taskReadiness(t, plan.tasks, plan.dependencies, bundle.constraints) : null
      },
      moveTasks: (ids, shift, cascade, reason) => apply((s, c) => ops.moveTasks(s, c, ids, shift, cascade), reason ?? ids.length + " Vorgänge verschoben"),
      previewMoveMany: (ids, shift) => ops.analyzeImpact(planRef.current, ops.moveTasks(planRef.current, ctx, ids, shift, true), ctx, ids),
      undo,
      redo,
      apply,
      previewMove: (id, newStart) =>
        previewWith((s) => {
          const t = s.tasks.find((x) => x.id === id)!
          const hasChildren = s.tasks.some((x) => x.parent_id === id)
          if (hasChildren) return ops.moveTask(s, ctx, id, newStart, true)
          if (t.scheduling_mode === 'manual' || t.actual_start) return ops.moveTask(s, ctx, id, newStart, true)
          return { ...s, tasks: s.tasks.map((x) => (x.id === id ? { ...x, constraint_type: 'mso', constraint_date: newStart } : x)) }
        }, id),
      previewDuration: (id, duration) => previewWith((s) => ({ ...s, tasks: s.tasks.map((x) => (x.id === id ? { ...x, duration: Math.max(1, duration), remaining_duration: null } : x)) }), id),
      moveTask: (id, start, cascade, reason) => apply((s, c) => ops.moveTask(s, c, id, start, cascade), reason ?? 'Vorgang verschoben'),
      setDuration: (id, d, cascade = true, reason) => apply((s, c) => ops.setDuration(s, c, id, d, cascade), reason ?? 'Dauer geändert'),
      setStart: (id, start, cascade = true, reason) => apply((s, c) => ops.setStartDate(s, c, id, start, cascade), reason ?? 'Start geändert'),
      setEnd: (id, end, cascade = true, reason) => apply((s, c) => ops.setEndDate(s, c, id, end, cascade), reason ?? 'Ende geändert'),
      updateTask: (id, patch, reason) => apply((s, c) => ops.updateTaskFields(s, c, id, patch), reason),
      createTask: (input, reason) => apply((s, c) => ops.createTask(s, c, input), reason ?? 'Vorgang angelegt'),
      deleteTasks: (ids) => apply((s, c) => ops.deleteTasks(s, c, ids), 'Vorgang gelöscht'),
      duplicateTask: (id) => apply((s, c) => ops.duplicateTask(s, c, id, () => newClientId()), 'Vorgang dupliziert'),
      indent: (id) => apply((s, c) => ops.indentTask(s, c, id), 'Struktur geändert'),
      outdent: (id) => apply((s, c) => ops.outdentTask(s, c, id), 'Struktur geändert'),
      moveInTree: (id, dir) => apply((s, c) => ops.moveTaskInTree(s, c, id, dir), 'Reihenfolge geändert'),
      addDependency: (pred, succ, type = 'FS', lag = 0) => {
        let err: string | null = null
        apply((s, c) => {
          const r = ops.addDependency(s, c, { id: newClientId('dep'), predecessor_id: pred, successor_id: succ, type, lag_days: lag })
          err = r.error ?? null
          return r.state
        }, 'Abhängigkeit erstellt')
        if (err) toast.push(err, 'error')
        return err
      },
      updateDependency: (id, patch) => apply((s, c) => ops.updateDependency(s, c, id, patch), 'Abhängigkeit geändert'),
      removeDependency: (id) => apply((s, c) => ops.removeDependency(s, c, id), 'Abhängigkeit entfernt'),
      releaseConstraint: (id) => apply((s, c) => ops.releaseConstraint(s, c, id), 'Automatische Planung wiederhergestellt'),
      saveBaseline: async (name) => {
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current)
          saveTimer.current = null
          await flush()
        }
        const b = await api.projects.saveBaseline(projectId, name)
        await load()
        return b
      },
      siteUpdate: async (taskId, req) => {
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current)
          saveTimer.current = null
          await flush()
        }
        const res = await api.projects.siteUpdate(projectId, taskId, req)
        versionRef.current = Math.max(versionRef.current, res.version)
        await load()
      },
      updateProject: async (patch) => {
        await api.projects.update(projectId, patch)
        await load()
      },
      enterScenario: (scenario) => {
        setMode({ kind: 'scenario', scenario })
        const st = ops.recompute({ tasks: scenario.tasks, dependencies: scenario.dependencies }, ctx).state
        planRef.current = st
        setPlan(st)
        undoStack.current = []
        redoStack.current = []
      },
      exitScenario: () => {
        setMode({ kind: 'plan' })
        void load()
      },
      newId: newClientId,
    }
  }, [projectId, bundle, loading, error, plan, ctx, analysis, mode, saving, dirty, canEdit, today, load, reloadMeta, undo, redo, apply, flush, toast])

  return <ProjectContext.Provider value={store}>{children}</ProjectContext.Provider>
}

export function useProject(): ProjectStore {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProject außerhalb von ProjectProvider')
  return ctx
}
