/**
 * BuildFlow-Adapter: übersetzt einen BuildFlow-Prozess in eine Terminplan-Struktur
 * (TemplateTask-Form, die `instantiateTemplate` in echte Vorgänge verwandelt) und
 * erkennt Änderungen zwischen zwei Prozessständen als Change-Proposal-Operationen.
 *
 * Mapping (Konzept):
 *   Prozess            → Phase (Sammelvorgang, type 'phase')
 *   Bereich (area)     → Gruppe (Unterprozess)
 *   Schritt            → Vorgang (aufgabe, dokument, checkliste, benachrichtigung)
 *   Entscheidung       → Meilenstein (Entscheidungspunkt)
 *   Ende               → Meilenstein
 *   Wartepunkt (Dauer) → Lag auf den ausgehenden Abhängigkeiten
 *   Wartepunkt (Ereign.) → Voraussetzung (Freigabe/Sonstiges) am Nachfolger
 *   Verbindung         → Abhängigkeit FS
 *   Verantwortlicher   → Rolle im Notizfeld + spätere Zuordnung zu Ressource/Benutzer
 *   Frist (leadTime)   → Einschränkung FNLT relativ zu Projektstart/-ende
 */

import type { ConstraintKind, ProposalOperation, Task, TaskDependency, TemplateTask } from '../../types.ts'
import type { BuildFlowDuration, BuildFlowNode, BuildFlowProcess } from './types.ts'
import { addDays } from '../../engine/dates.ts'

/** Umrechnung in Arbeitstage (min/std → mindestens 1 AT; Woche = 5 AT) */
export function durationToWorkdays(d: BuildFlowDuration | undefined, fallback = 1): number {
  if (!d || !(d.value > 0)) return fallback
  switch (d.unit) {
    case 'wochen': return Math.max(1, Math.round(d.value * 5))
    case 'tage': return Math.max(1, Math.round(d.value))
    case 'std': return Math.max(1, Math.ceil(d.value / 8))
    case 'min': return 1
  }
}

/** Kalendertage (für Fristen) */
export function durationToCalendarDays(d: BuildFlowDuration | undefined): number {
  if (!d || !(d.value > 0)) return 0
  switch (d.unit) {
    case 'wochen': return Math.round(d.value * 7)
    case 'tage': return Math.round(d.value)
    case 'std': return Math.ceil(d.value / 24)
    case 'min': return 1
  }
}

export interface BuildFlowMappingOptions {
  /** Schlüssel-Präfix (bei mehreren Prozessen in einem Plan) */
  keyPrefix?: string
  /** Prozess als eigene Phase kapseln (Standard true) */
  wrapInPhase?: boolean
  /** Rollen-ID → Name (aus Export), für lesbare Notizen */
  roleNames?: Map<string, string>
  /** Projektzeitraum für Fristen (FNLT) */
  projectStart?: string
  projectEnd?: string
}

export interface MappedProcess {
  tasks: TemplateTask[]
  /** Schritt-ID → Vorlagen-Key (für Diff/Sync) */
  keyByNode: Map<string, string>
  /** Fristen: Key → constraint */
  deadlines: { key: string; type: 'fnlt'; date: string; note: string }[]
  /** Hinweise (z. B. übersprungene Knoten) */
  notes: string[]
}

/** Prozess → Vorlagenstruktur (ohne Termine - die berechnet die Engine beim Anlegen). */
export function mapProcessToTemplate(process: BuildFlowProcess, opts: BuildFlowMappingOptions = {}): MappedProcess {
  const prefix = opts.keyPrefix ?? 'bf'
  const wrap = opts.wrapInPhase !== false
  const roleName = (id?: string) => (id ? (opts.roleNames?.get(id) ?? process.roles?.find((r) => r.id === id)?.name ?? id) : null)
  const tasks: TemplateTask[] = []
  const keyByNode = new Map<string, string>()
  const notes: string[] = []
  const deadlines: MappedProcess['deadlines'] = []
  let sort = 0
  const push = (t: Omit<TemplateTask, 'id' | 'template_id' | 'sort_order'>) => {
    tasks.push({ id: `${prefix}_${t.key}`, template_id: prefix, sort_order: sort++, ...t })
  }
  const phaseKey = `${prefix}_phase`
  if (wrap) push({ key: phaseKey, parent_key: null, name: process.name, type: 'phase', duration: 0, trade_name: null, section_name: null, dependencies: [], constraints: [] })
  const rootParent = wrap ? phaseKey : null

  // Bereiche → Gruppen (in Reihenfolge des ersten Auftretens)
  const areaKeys = new Map<string, string>()
  const ordered = topoOrder(process)
  for (const n of ordered) {
    if (!n.area) continue
    if (areaKeys.has(n.area)) continue
    const k = `${prefix}_area_${areaKeys.size + 1}`
    areaKeys.set(n.area, k)
    push({ key: k, parent_key: rootParent, name: n.area, type: 'group', duration: 0, trade_name: null, section_name: null, dependencies: [], constraints: [] })
  }

  // Wartepunkte: Dauer → Lag, Ereignis → Voraussetzung; sie werden selbst nicht zu Vorgängen
  const waitNodes = new Map(process.nodes.filter((n) => n.kind === 'warten').map((n) => [n.id, n]))
  const startIds = new Set(process.nodes.filter((n) => n.kind === 'start').map((n) => n.id))

  for (const n of ordered) {
    if (n.kind === 'start' || n.kind === 'warten') continue
    const key = `${prefix}_${sanitize(n.id)}`
    keyByNode.set(n.id, key)
    const parent = n.area ? (areaKeys.get(n.area) ?? rootParent) : rootParent
    const isMilestone = n.kind === 'entscheidung' || n.kind === 'ende'
    const role = roleName(n.roleId)
    const noteParts: string[] = []
    if (role) noteParts.push(`Verantwortlich (BuildFlow-Rolle): ${role}`)
    if (n.externalResponsible) noteParts.push(`Extern: ${n.externalResponsible}`)
    if (n.condition) noteParts.push(`Entscheidung: ${n.condition}`)
    if (n.description) noteParts.push(n.description)
    const duration = isMilestone ? 0 : durationToWorkdays(n.processDuration ?? n.duration, 1)
    const constraints: TemplateTask['constraints'] = []
    const dependencies: TemplateTask['dependencies'] = []
    // Vorgänger über Kanten, Wartepunkte dazwischen auflösen
    for (const e of process.edges) {
      if (e.to !== n.id) continue
      resolvePredecessors(process, e.from, waitNodes, startIds, 0, [], (predId, lagDays, events) => {
        const pk = keyByNode.get(predId) ?? `${prefix}_${sanitize(predId)}`
        if (!dependencies.some((d) => d.predecessor_key === pk)) dependencies.push({ predecessor_key: pk, type: 'FS', lag_days: lagDays })
        for (const ev of events) constraints.push({ type: constraintKindFor(ev), title: ev })
      })
    }
    push({ key, parent_key: parent, name: isMilestone && n.kind === 'entscheidung' ? `Entscheidung: ${n.name}` : n.name, type: isMilestone ? 'milestone' : 'task', duration, trade_name: null, section_name: null, dependencies, constraints, notes: noteParts.join('\n') })
    if (n.leadTime && n.scheduleAnchor && (opts.projectStart || opts.projectEnd)) {
      const anchor = n.scheduleAnchor === 'projektende' ? opts.projectEnd : opts.projectStart
      if (anchor) deadlines.push({ key, type: 'fnlt', date: addDays(anchor, -durationToCalendarDays(n.leadTime)), note: `Frist aus BuildFlow: ${durationToCalendarDays(n.leadTime)} Tage vor ${n.scheduleAnchor === 'projektende' ? 'Projektende' : 'Projektstart'}` })
    }
  }
  const skipped = process.nodes.filter((n) => n.kind === 'warten').length
  if (skipped) notes.push(`${skipped} Wartepunkt(e) als Lag/Voraussetzung übernommen.`)
  return { tasks, keyByNode, deadlines, notes }
}

function constraintKindFor(event: string): ConstraintKind {
  const e = event.toLowerCase()
  if (/freigabe|genehmig/.test(e)) return 'approval'
  if (/bauherr|kunde|auftraggeber/.test(e)) return 'client'
  if (/behörde|amt/.test(e)) return 'authority'
  if (/material|lieferung/.test(e)) return 'material'
  if (/plan|zeichnung|statik/.test(e)) return 'planning'
  return 'other'
}

/** Folgt Kanten rückwärts über Wartepunkte/Start hinweg zum nächsten echten Schritt. */
function resolvePredecessors(
  process: BuildFlowProcess,
  fromId: string,
  waitNodes: Map<string, BuildFlowNode>,
  startIds: Set<string>,
  lag: number,
  events: string[],
  emit: (predId: string, lagDays: number, events: string[]) => void,
  depth = 0,
): void {
  if (depth > 20) return
  if (startIds.has(fromId)) return
  const w = waitNodes.get(fromId)
  if (!w) {
    emit(fromId, lag, events)
    return
  }
  const addLag = w.wait?.kind === 'dauer' ? durationToWorkdays(w.wait.duration, 0) : 0
  const addEvents = w.wait?.kind === 'ereignis' && w.wait.event ? [...events, w.wait.event] : events
  for (const e of process.edges) if (e.to === fromId) resolvePredecessors(process, e.from, waitNodes, startIds, lag + addLag, addEvents, emit, depth + 1)
}

/** Topologische Reihenfolge (Kahn); Knoten in Zyklen/ohne Kanten hinten in Originalreihenfolge. */
function topoOrder(process: BuildFlowProcess): BuildFlowNode[] {
  const indeg = new Map<string, number>()
  const byId = new Map(process.nodes.map((n) => [n.id, n]))
  for (const n of process.nodes) indeg.set(n.id, 0)
  for (const e of process.edges) if (byId.has(e.to) && byId.has(e.from)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  const queue = process.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id)
  const out: BuildFlowNode[] = []
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    out.push(byId.get(id)!)
    for (const e of process.edges) {
      if (e.from !== id || !byId.has(e.to)) continue
      indeg.set(e.to, (indeg.get(e.to) ?? 1) - 1)
      if (indeg.get(e.to) === 0) queue.push(e.to)
    }
  }
  for (const n of process.nodes) if (!seen.has(n.id)) out.push(n)
  return out
}

export function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_')
}

// ---------------------------------------------------------------- Synchronisation (Diff)

/** Vorlagen-Key eines beim Abgleich neu hinzugefügten Schritts (add_task.key) */
export function newNodeKey(nodeId: string): string {
  return `bfnew_${sanitize(nodeId)}`
}

export interface ProcessDiff {
  added: BuildFlowNode[]
  removed: BuildFlowNode[]
  changed: { before: BuildFlowNode; after: BuildFlowNode; fields: string[] }[]
  edgesAdded: { from: string; to: string }[]
  edgesRemoved: { from: string; to: string }[]
}

/** Vergleicht zwei Stände desselben Prozesses (Knoten-IDs bleiben in BuildFlow stabil). */
export function diffProcess(before: BuildFlowProcess, after: BuildFlowProcess): ProcessDiff {
  const b = new Map(before.nodes.map((n) => [n.id, n]))
  const a = new Map(after.nodes.map((n) => [n.id, n]))
  const added = after.nodes.filter((n) => !b.has(n.id))
  const removed = before.nodes.filter((n) => !a.has(n.id))
  const changed: ProcessDiff['changed'] = []
  for (const n of after.nodes) {
    const o = b.get(n.id)
    if (!o) continue
    const fields: string[] = []
    if (o.name !== n.name) fields.push('name')
    if (durationToWorkdays(o.processDuration ?? o.duration) !== durationToWorkdays(n.processDuration ?? n.duration)) fields.push('duration')
    if ((o.roleId ?? '') !== (n.roleId ?? '')) fields.push('role')
    if ((o.area ?? '') !== (n.area ?? '')) fields.push('area')
    if (o.kind !== n.kind) fields.push('kind')
    if (fields.length) changed.push({ before: o, after: n, fields })
  }
  const ek = (e: { from: string; to: string }) => `${e.from}>${e.to}`
  const be = new Set(before.edges.map(ek))
  const ae = new Set(after.edges.map(ek))
  const edgesAdded = after.edges.filter((e) => !be.has(ek(e))).map((e) => ({ from: e.from, to: e.to }))
  const edgesRemoved = before.edges.filter((e) => !ae.has(ek(e))).map((e) => ({ from: e.from, to: e.to }))
  return { added, removed, changed, edgesAdded, edgesRemoved }
}

/**
 * Diff → Change-Proposal-Operationen gegen den laufenden Plan. `taskIdByNode` ist die beim
 * Import gespeicherte Zuordnung Schritt-ID → Vorgangs-ID; `tasks`/`deps` der aktuelle Plan.
 */
export function diffToOperations(diff: ProcessDiff, after: BuildFlowProcess, taskIdByNode: Record<string, string>, tasks: Task[], deps: TaskDependency[], phaseTaskId: string | null): { operations: ProposalOperation[]; summary: string[] } {
  const ops: ProposalOperation[] = []
  const summary: string[] = []
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const idOf = (nodeId: string): string | null => {
    const id = taskIdByNode[nodeId]
    return id && taskById.has(id) ? id : null
  }
  const keyOf = (nodeId: string) => newNodeKey(nodeId)
  const roleName = (id?: string) => (id ? (after.roles?.find((r) => r.id === id)?.name ?? id) : null)

  for (const n of diff.added) {
    if (n.kind === 'start' || n.kind === 'warten') continue
    const isMs = n.kind === 'entscheidung' || n.kind === 'ende'
    // Elternknoten: Gruppe des Bereichs, falls ein bestehender Vorgang desselben Bereichs existiert
    const sibling = after.nodes.find((x) => x.id !== n.id && x.area && x.area === n.area && idOf(x.id))
    const parent = sibling ? (taskById.get(idOf(sibling.id)!)?.parent_id ?? phaseTaskId) : phaseTaskId
    const role = roleName(n.roleId)
    ops.push({ op: 'add_task', key: keyOf(n.id), name: isMs && n.kind === 'entscheidung' ? `Entscheidung: ${n.name}` : n.name, type: isMs ? 'milestone' : 'task', duration: isMs ? 0 : durationToWorkdays(n.processDuration ?? n.duration, 1), parent_id: parent, notes: role ? `Verantwortlich (BuildFlow-Rolle): ${role}` : '' })
    summary.push(`Neuer Schritt „${n.name}“`)
  }
  for (const c of diff.changed) {
    const id = idOf(c.after.id)
    if (!id) continue
    const fields: { name?: string; duration?: number } = {}
    if (c.fields.includes('name')) fields.name = c.after.name
    if (c.fields.includes('duration') && c.after.kind !== 'entscheidung' && c.after.kind !== 'ende') fields.duration = durationToWorkdays(c.after.processDuration ?? c.after.duration, 1)
    if (Object.keys(fields).length) {
      ops.push({ op: 'update_task', task_id: id, fields })
      summary.push(`„${c.before.name}“ geändert (${c.fields.join(', ')})`)
    }
  }
  for (const n of diff.removed) {
    const id = idOf(n.id)
    if (!id) continue
    ops.push({ op: 'remove_task', task_id: id })
    summary.push(`Schritt „${n.name}“ entfernt`)
  }
  const ref = (nodeId: string): string | null => idOf(nodeId) ?? (diff.added.some((a) => a.id === nodeId) ? keyOf(nodeId) : null)
  const waitNodes = new Map(after.nodes.filter((n) => n.kind === 'warten').map((n) => [n.id, n]))
  const startIds = new Set(after.nodes.filter((n) => n.kind === 'start').map((n) => n.id))
  const removedIds = new Set(diff.removed.map((n) => n.id))
  for (const e of diff.edgesAdded) {
    if (waitNodes.has(e.to) || startIds.has(e.from)) continue // Wartepunkt: die ausgehende Kante trägt Lag/Ereignis
    const s = ref(e.to)
    if (!s) continue
    resolvePredecessors(after, e.from, waitNodes, startIds, 0, [], (predId, lag, events) => {
      const p = ref(predId)
      if (!p) return
      if (!ops.some((o) => o.op === 'add_dependency' && o.predecessor === p && o.successor === s)) {
        ops.push({ op: 'add_dependency', predecessor: p, successor: s, type: 'FS', lag_days: lag })
        summary.push('Neue Verbindung')
      }
      for (const ev of events) ops.push(idOf(e.to) ? { op: 'add_constraint', task_id: s, type: constraintKindFor(ev), title: ev } : { op: 'add_constraint', task_key: s, type: constraintKindFor(ev), title: ev })
    })
  }
  for (const e of diff.edgesRemoved) {
    if (removedIds.has(e.from) || removedIds.has(e.to)) continue // fällt mit dem Vorgang weg
    const p = idOf(e.from)
    const s = idOf(e.to)
    if (!p || !s) continue
    const d = deps.find((x) => x.predecessor_id === p && x.successor_id === s)
    if (d) {
      ops.push({ op: 'remove_dependency', dependency_id: d.id })
      summary.push('Verbindung entfernt')
    }
  }
  return { operations: ops, summary }
}
