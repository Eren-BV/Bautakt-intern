/**
 * V1-Routen: Abschnitte, Voraussetzungen, Ressourcen-Zuweisungen, Änderungsvorschläge,
 * Share-Links, Arbeitspakete, Import (CSV) und Erfahrungswerte.
 */

import { Hono } from 'hono'
import { HttpError, requireCap, sha256Hex, type AppEnv } from '../auth.ts'
import { newId, nowISO, randomToken, type Row } from '../db.ts'
import { Repo } from '../repo.ts'
import { ProjectService } from '../services/projectService.ts'
import type { ChangeProposal, ConstraintKind, ConstraintStatus, ProjectSection, ProposalOperation, ResourceAssignment, Scenario, ShareLink, ShareRelevance, TaskConstraint, WorkPackageTask, WorkPackageTemplate } from '../../shared/types.ts'
import { analyzeImpact, recompute, type PlanState } from '../../shared/engine/operations.ts'
import { applyOperations, describeOperation, operationKind, proposalOperations } from '../../shared/engine/proposals.ts'
import { effectiveRules, evaluateRules } from '../../shared/rules/engine.ts'
import { decideProposal } from '../services/proposalService.ts'
import { mapProposal } from '../repo.ts'
import { analyzeProject } from '../../shared/engine/analysis.ts'
import { insertWorkPackage } from '../../shared/templates/workPackages.ts'
import { parseCsv, mapImportRows, validateImport, type ImportMapping } from '../../shared/import/pipeline.ts'
import { newDependency, newTask } from '../../shared/engine/defaults.ts'
import { formatDate, todayISO } from '../../shared/engine/dates.ts'
import { pushNotification } from '../services/notificationService.ts'
import { broadcastProject } from '../services/realtime.ts'

export const v1Routes = new Hono<AppEnv>()
const CONSTRAINT_KINDS: ConstraintKind[] = ['predecessor', 'material', 'planning', 'approval', 'staff', 'equipment', 'authority', 'client', 'other']

async function requireProject(c: { get: (k: 'db' | 'session') => unknown }, projectId: string) {
  const repo = new Repo(c.get('db') as AppEnv['Variables']['db'])
  const s = c.get('session') as AppEnv['Variables']['session']
  const project = await repo.project(s.org.id, projectId)
  if (!project) throw new HttpError(404, 'Projekt nicht gefunden.')
  return { repo, session: s, project }
}

// ---------------------------------------------------------------- Abschnitte
v1Routes.post('/projects/:id/sections', requireCap('plan.edit'), async (c) => {
  const { repo } = await requireProject(c, c.req.param('id'))
  const body = await c.req.json<{ name: string }>()
  if (!body.name?.trim()) throw new HttpError(400, 'Name ist erforderlich.')
  const existing = await repo.sections(c.req.param('id'))
  const sec: ProjectSection = { id: newId('sec'), project_id: c.req.param('id'), name: body.name.trim(), sort_order: existing.length }
  await c.get('db').insert('project_sections', sec)
  return c.json(await repo.sections(c.req.param('id')), 201)
})
v1Routes.patch('/projects/:id/sections/:sid', requireCap('plan.edit'), async (c) => {
  const { repo } = await requireProject(c, c.req.param('id'))
  const body = await c.req.json<{ name?: string; sort_order?: number }>()
  await c.get('db').run('UPDATE project_sections SET name = COALESCE(?, name), sort_order = COALESCE(?, sort_order) WHERE id = ? AND project_id = ?', body.name ?? null, body.sort_order ?? null, c.req.param('sid'), c.req.param('id'))
  return c.json(await repo.sections(c.req.param('id')))
})
v1Routes.delete('/projects/:id/sections/:sid', requireCap('plan.edit'), async (c) => {
  const { repo } = await requireProject(c, c.req.param('id'))
  const db = c.get('db')
  await db.transaction(async () => {
    await db.run('UPDATE tasks SET section_id = NULL WHERE project_id = ? AND section_id = ?', c.req.param('id'), c.req.param('sid'))
    await db.run('DELETE FROM project_sections WHERE id = ? AND project_id = ?', c.req.param('sid'), c.req.param('id'))
  })
  return c.json(await repo.sections(c.req.param('id')))
})

// ---------------------------------------------------------------- Voraussetzungen
v1Routes.post('/projects/:id/constraints', requireCap('site.update'), async (c) => {
  const { repo } = await requireProject(c, c.req.param('id'))
  const body = await c.req.json<Partial<TaskConstraint>>()
  if (!body.task_id || !body.title?.trim()) throw new HttpError(400, 'Vorgang und Bezeichnung sind erforderlich.')
  const tasks = await repo.tasks(c.req.param('id'))
  if (!tasks.some((t) => t.id === body.task_id)) throw new HttpError(404, 'Vorgang nicht gefunden.')
  const type = CONSTRAINT_KINDS.includes(body.type as ConstraintKind) ? (body.type as ConstraintKind) : 'other'
  const item: TaskConstraint = {
    id: newId('cs'), project_id: c.req.param('id'), task_id: body.task_id, type, title: body.title.trim(), status: (body.status as ConstraintStatus) ?? 'open',
    due_date: body.due_date ?? null, responsible_user_id: body.responsible_user_id ?? null, note: body.note ?? '', created_at: nowISO(), updated_at: nowISO(),
  }
  await c.get('db').insert('task_constraints', item)
  return c.json(await repo.constraints(c.req.param('id')), 201)
})
v1Routes.patch('/projects/:id/constraints/:cid', requireCap('site.update'), async (c) => {
  const { repo } = await requireProject(c, c.req.param('id'))
  const body = await c.req.json<Partial<TaskConstraint>>()
  const patch: Record<string, unknown> = { updated_at: nowISO() }
  for (const k of ['type', 'title', 'status', 'due_date', 'responsible_user_id', 'note'] as const) if (body[k] !== undefined) patch[k] = body[k]
  const exists = await c.get('db').get('SELECT id FROM task_constraints WHERE id = ? AND project_id = ?', c.req.param('cid'), c.req.param('id'))
  if (!exists) throw new HttpError(404, 'Voraussetzung nicht gefunden.')
  await c.get('db').update('task_constraints', c.req.param('cid'), patch)
  return c.json(await repo.constraints(c.req.param('id')))
})
v1Routes.delete('/projects/:id/constraints/:cid', requireCap('plan.edit'), async (c) => {
  const { repo } = await requireProject(c, c.req.param('id'))
  await c.get('db').run('DELETE FROM task_constraints WHERE id = ? AND project_id = ?', c.req.param('cid'), c.req.param('id'))
  return c.json(await repo.constraints(c.req.param('id')))
})

// ---------------------------------------------------------------- Ressourcen-Zuweisungen
v1Routes.put('/projects/:id/tasks/:taskId/assignments', requireCap('plan.edit'), async (c) => {
  const { repo, session } = await requireProject(c, c.req.param('id'))
  const db = c.get('db')
  const tasks = await repo.tasks(c.req.param('id'))
  if (!tasks.some((t) => t.id === c.req.param('taskId'))) throw new HttpError(404, 'Vorgang nicht gefunden.')
  const body = await c.req.json<{ assignments: Partial<ResourceAssignment>[] }>()
  const resources = await repo.resources(session.org.id)
  const validResources = new Set(resources.map((r) => r.id))
  await db.transaction(async () => {
    await db.run('DELETE FROM resource_assignments WHERE task_id = ?', c.req.param('taskId'))
    for (const a of body.assignments ?? []) {
      if (!a.resource_id || !validResources.has(a.resource_id)) continue
      await db.insert('resource_assignments', { id: newId('ra'), task_id: c.req.param('taskId'), resource_id: a.resource_id, units: Number(a.units) || 1, start_date: a.start_date ?? null, end_date: a.end_date ?? null })
    }
  })
  return c.json(await repo.assignments(c.req.param('id')))
})

// ---------------------------------------------------------------- Änderungsvorschläge
v1Routes.get('/projects/:id/proposals', async (c) => {
  const { repo } = await requireProject(c, c.req.param('id'))
  return c.json(await repo.proposals(c.req.param('id')))
})
v1Routes.get('/proposals/open', async (c) => {
  const s = c.get('session')
  const rows = await c.get('db').all<Row>(
    "SELECT cp.*, p.name AS project_name, t.name AS task_name FROM change_proposals cp JOIN projects p ON p.id = cp.project_id LEFT JOIN tasks t ON t.id = cp.task_id WHERE p.org_id = ? AND cp.status = 'open' ORDER BY cp.created_at DESC",
    s.org.id,
  )
  return c.json(rows.map((r) => ({ ...mapProposal(r), project_name: String(r.project_name ?? ''), task_name: String(r.task_name ?? '') })))
})
/** Manueller Vorschlag (einfach: Vorgang + Start/Ende, oder strukturiert: operations) */
v1Routes.post('/projects/:id/proposals', requireCap('site.update'), async (c) => {
  const { repo, session } = await requireProject(c, c.req.param('id'))
  const body = await c.req.json<{ task_id?: string | null; proposed_start?: string | null; proposed_end?: string | null; operations?: ProposalOperation[]; title?: string; reason?: string; comment?: string }>()
  const tasks = await repo.tasks(c.req.param('id'))
  if (body.task_id && !tasks.some((t) => t.id === body.task_id)) throw new HttpError(404, 'Vorgang nicht gefunden.')
  if (!body.task_id && !body.operations?.length) throw new HttpError(400, 'Vorgang oder Operationen erforderlich.')
  const taskName = tasks.find((t) => t.id === body.task_id)?.name ?? ''
  const p: ChangeProposal = {
    id: newId('cp'), project_id: c.req.param('id'), task_id: body.task_id ?? null, source: 'MANUAL', status: 'open', title: body.title ?? (taskName ? `${taskName}: Terminänderung` : 'Änderungsvorschlag'),
    proposed_start: body.proposed_start ?? null, proposed_end: body.proposed_end ?? null, operations: body.operations ?? [],
    reason: body.reason ?? '', comment: body.comment ?? '', submitted_by_name: session.user.name, submitted_by_user_id: session.user.id, share_link_id: null, origin_kind: 'manual', origin_ref: null,
    created_at: nowISO(), decided_at: null, decided_by: null, decision_note: '',
  }
  await c.get('db').insert('change_proposals', p)
  await broadcastProject(session.org.id, p.project_id, 'proposal')
  return c.json(p, 201)
})
/** Auswirkungsanalyse eines Vorschlags ohne Speichern (inkl. Regelverstöße und Operationsliste) */
v1Routes.get('/projects/:id/proposals/:pid/impact', async (c) => {
  const { repo, session } = await requireProject(c, c.req.param('id'))
  const db = c.get('db')
  const p = await repo.proposal(c.req.param('id'), c.req.param('pid'))
  if (!p) throw new HttpError(404, 'Vorschlag nicht gefunden.')
  const bundle = (await repo.bundle(session.org.id, c.req.param('id')))!
  const ctx = new ProjectService(db).planContext(bundle)
  const state: PlanState = { tasks: bundle.tasks, dependencies: bundle.dependencies }
  const ops = proposalOperations(p)
  const trades = await repo.trades(session.org.id)
  const applied = applyOperations(state, ctx, ops, { newId: (pre) => newId(pre), trades })
  const impact = analyzeImpact(state, applied.state, ctx, [])
  const a = analyzeProject(bundle)
  const rules = effectiveRules(await repo.rules(session.org.id), bundle.project.id, null, bundle.project.planning_kind === 'construction')
  const before = recompute(state, ctx)
  const after = recompute(applied.state, ctx)
  const vBefore = evaluateRules(rules, { tasks: before.state.tasks, dependencies: before.state.dependencies, sched: before.result, trades })
  const vAfter = evaluateRules(rules, { tasks: after.state.tasks, dependencies: after.state.dependencies, sched: after.result, trades })
  const beforeKeys = new Set(vBefore.map((v) => `${v.rule_id}|${v.task_id}|${v.related_task_id}`))
  const names = new Map([...bundle.tasks, ...applied.state.tasks].map((t) => [t.id, t.name]))
  for (const op of ops) if (op.op === 'add_task') names.set(op.key, op.name)
  return c.json({
    proposal: p, impact,
    milestones: impact.affected.filter((x) => bundle.tasks.find((t) => t.id === x.id)?.type === 'milestone'),
    current_end: a.planned_end,
    operations: ops.map((op) => ({ op, kind: operationKind(op), text: describeOperation(op, (id) => names.get(id) ?? id) })),
    warnings: applied.warnings,
    new_constraints: applied.constraints,
    new_rule_violations: vAfter.filter((v) => !beforeKeys.has(`${v.rule_id}|${v.task_id}|${v.related_task_id}`)),
  })
})
v1Routes.post('/projects/:id/proposals/:pid/decide', requireCap('plan.edit'), async (c) => {
  const { session, project } = await requireProject(c, c.req.param('id'))
  const body = await c.req.json<{ decision: 'accept' | 'reject'; note?: string }>()
  if (body.decision !== 'accept' && body.decision !== 'reject') throw new HttpError(400, 'Ungültige Entscheidung.')
  return c.json(await decideProposal(c.get('db'), session, project.id, c.req.param('pid'), body.decision, body.note ?? ''))
})
/** „Bearbeiten“: Vorschlag als Szenario öffnen - dort anpassen, vergleichen, dann übernehmen oder verwerfen */
v1Routes.post('/projects/:id/proposals/:pid/scenario', requireCap('scenario.manage'), async (c) => {
  const { repo, session, project } = await requireProject(c, c.req.param('id'))
  const db = c.get('db')
  const p = await repo.proposal(project.id, c.req.param('pid'))
  if (!p) throw new HttpError(404, 'Vorschlag nicht gefunden.')
  const bundle = (await repo.bundle(session.org.id, project.id))!
  const ctx = new ProjectService(db).planContext(bundle)
  const trades = await repo.trades(session.org.id)
  const applied = applyOperations({ tasks: bundle.tasks, dependencies: bundle.dependencies }, ctx, proposalOperations(p), { newId: (pre) => newId(pre), trades })
  const impact = analyzeImpact({ tasks: bundle.tasks, dependencies: bundle.dependencies }, applied.state, ctx, [])
  const sc: Scenario = {
    id: newId('sc'), project_id: project.id, name: `Vorschlag: ${p.title || p.submitted_by_name}`, description: p.comment, created_at: nowISO(), created_by: session.user.id,
    origin: 'proposal', proposal_id: p.id, meta: { changed_tasks: impact.affected.length, original_end: impact.oldProjectEnd, new_end: impact.newProjectEnd, delta_days: impact.projectEndShiftDays },
    tasks: applied.state.tasks, dependencies: applied.state.dependencies,
  }
  await db.insert('scenarios', sc)
  return c.json(sc, 201)
})

// ---------------------------------------------------------------- Share-Links (Kategorieplan)
v1Routes.get('/projects/:id/share-links', async (c) => {
  await requireProject(c, c.req.param('id'))
  const rows = await c.get('db').all<Row>('SELECT * FROM share_links WHERE project_id = ? ORDER BY created_at DESC', c.req.param('id'))
  return c.json(rows.map(mapShare))
})
v1Routes.post('/projects/:id/share-links', requireCap('project.edit'), async (c) => {
  const { session, project } = await requireProject(c, c.req.param('id'))
  const body = await c.req.json<{ scope?: 'trade' | 'company'; trade_id?: string | null; company_id?: string | null; label?: string; relevance?: ShareRelevance; expires_in_days?: number | null }>()
  if (!body.trade_id && !body.company_id) throw new HttpError(400, 'Kategorie oder Firma ist erforderlich.')
  const token = randomToken(24)
  const link: ShareLink & { token_hash: string } = {
    id: newId('sh'), org_id: session.org.id, project_id: project.id, token_hash: await sha256Hex(token), scope: body.company_id ? 'company' : 'trade',
    trade_id: body.trade_id ?? null, company_id: body.company_id ?? null, label: body.label ?? '', relevance: body.relevance ?? 'standard',
    expires_at: body.expires_in_days ? new Date(Date.now() + body.expires_in_days * 86_400_000).toISOString() : null, revoked_at: null, created_by: session.user.id, created_at: nowISO(), last_used_at: null, use_count: 0,
  }
  await c.get('db').insert('share_links', link)
  const { token_hash: _h, ...pub } = link
  return c.json({ ...pub, url: `/share/${token}` }, 201)
})
v1Routes.post('/projects/:id/share-links/:sid/revoke', requireCap('project.edit'), async (c) => {
  await requireProject(c, c.req.param('id'))
  await c.get('db').run('UPDATE share_links SET revoked_at = ? WHERE id = ? AND project_id = ?', nowISO(), c.req.param('sid'), c.req.param('id'))
  return c.json({ ok: true })
})
function mapShare(r: Row): ShareLink {
  const { token_hash: _h, ...rest } = r as unknown as ShareLink & { token_hash: string }
  return rest
}

// ---------------------------------------------------------------- Arbeitspakete
v1Routes.get('/work-packages', async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const rows = await db.all<Row>('SELECT * FROM work_package_templates WHERE org_id = ? OR org_id IS NULL ORDER BY is_builtin DESC, name', s.org.id)
  const list = rows.map((r) => ({ ...(r as unknown as WorkPackageTemplate), is_builtin: r.is_builtin === 1 }))
  const withCounts = await Promise.all(list.map(async (w) => ({ ...w, task_count: (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM work_package_tasks WHERE package_id = ?', w.id))?.n ?? 0 })))
  return c.json(withCounts)
})
v1Routes.get('/work-packages/:wid', async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const w = await db.get<Row>('SELECT * FROM work_package_templates WHERE id = ? AND (org_id = ? OR org_id IS NULL)', c.req.param('wid'), s.org.id)
  if (!w) throw new HttpError(404, 'Arbeitspaket nicht gefunden.')
  return c.json({ package: { ...(w as unknown as WorkPackageTemplate), is_builtin: w.is_builtin === 1 }, tasks: await loadPackageTasks(db, c.req.param('wid')) })
})
v1Routes.post('/work-packages', requireCap('templates.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const body = await c.req.json<{ name: string; description?: string; tasks: WorkPackageTask[]; copy_of?: string }>()
  if (!body.name?.trim()) throw new HttpError(400, 'Name ist erforderlich.')
  const id = newId('wp')
  const tasks = body.copy_of ? await loadPackageTasks(db, body.copy_of) : body.tasks ?? []
  await db.transaction(async () => {
    await db.insert('work_package_templates', { id, org_id: s.org.id, name: body.name.trim(), description: body.description ?? '', is_builtin: false, created_at: nowISO() })
    let i = 0
    for (const t of tasks) {
      await db.insert('work_package_tasks', { ...t, id: newId('wpt'), package_id: id, sort_order: i, dependencies: t.dependencies ?? [], constraints: t.constraints ?? [] })
      i++
    }
  })
  return c.json({ package: await db.get('SELECT * FROM work_package_templates WHERE id = ?', id), tasks: await loadPackageTasks(db, id) }, 201)
})
v1Routes.delete('/work-packages/:wid', requireCap('templates.manage'), async (c) => {
  const s = c.get('session')
  await c.get('db').run('DELETE FROM work_package_templates WHERE id = ? AND org_id = ? AND is_builtin = 0', c.req.param('wid'), s.org.id)
  return c.json({ ok: true })
})
/** Arbeitspaket in ein Projekt einfügen (transaktional, mit Historie und Voraussetzungen) */
v1Routes.post('/projects/:id/work-packages/:wid/insert', requireCap('plan.edit'), async (c) => {
  const { repo, session, project } = await requireProject(c, c.req.param('id'))
  const db = c.get('db')
  const body = await c.req.json<{ parent_id?: string | null; after_id?: string | null; start_date?: string | null; section_id?: string | null; predecessor_id?: string | null; root_name?: string; expected_version: number }>()
  const w = await db.get<Row>('SELECT * FROM work_package_templates WHERE id = ? AND (org_id = ? OR org_id IS NULL)', c.req.param('wid'), session.org.id)
  if (!w) throw new HttpError(404, 'Arbeitspaket nicht gefunden.')
  const bundle = (await repo.bundle(session.org.id, project.id))!
  const svc = new ProjectService(db)
  const ctx = svc.planContext(bundle)
  const packageTasks = await loadPackageTasks(db, c.req.param('wid'))
  const trades = await repo.trades(session.org.id)
  const result = insertWorkPackage({ tasks: bundle.tasks, dependencies: bundle.dependencies }, ctx, packageTasks, { parent_id: body.parent_id ?? null, after_id: body.after_id ?? null, start_date: body.start_date ?? null, section_id: body.section_id ?? null, predecessor_id: body.predecessor_id ?? null, root_name: body.root_name }, trades, () => newId('t'))
  const res = await svc.savePlan(session, project.id, { expected_version: body.expected_version ?? project.version, tasks: result.state.tasks, dependencies: result.state.dependencies, reason: `Arbeitspaket „${String(w.name)}“ eingefügt`, source: 'WORK_PACKAGE' })
  for (const cs of result.constraints) await db.insert('task_constraints', { id: newId('cs'), ...cs, created_at: nowISO(), updated_at: nowISO() })
  return c.json({ ...res, inserted_ids: result.insertedIds })
})
async function loadPackageTasks(db: AppEnv['Variables']['db'], id: string): Promise<WorkPackageTask[]> {
  const rows = await db.all<Row>('SELECT * FROM work_package_tasks WHERE package_id = ? ORDER BY sort_order', id)
  return rows.map((r) => ({ ...(r as unknown as WorkPackageTask), dependencies: JSON.parse(String(r.dependencies ?? '[]')), constraints: JSON.parse(String(r.constraints ?? '[]')) }))
}

// ---------------------------------------------------------------- Import (Pipeline: Datei → Parser → Normalisiert → Mapping → Validierung → Review → Projekt)
v1Routes.post('/projects/:id/import/preview', requireCap('plan.edit'), async (c) => {
  await requireProject(c, c.req.param('id'))
  const body = await c.req.json<{ csv: string; mapping?: Partial<ImportMapping> }>()
  const parsed = parseCsv(body.csv ?? '')
  const mapping = mapImportRows(parsed, body.mapping)
  const validation = validateImport(mapping)
  return c.json({ headers: parsed.headers, row_count: parsed.rows.length, mapping: mapping.mapping, items: mapping.items, validation })
})
v1Routes.post('/projects/:id/import/apply', requireCap('plan.edit'), async (c) => {
  const { repo, session, project } = await requireProject(c, c.req.param('id'))
  const db = c.get('db')
  const body = await c.req.json<{ csv: string; mapping?: Partial<ImportMapping>; mode: 'tasks' | 'estimate'; parent_id?: string | null; filename?: string; expected_version: number }>()
  const parsed = parseCsv(body.csv ?? '')
  const mapped = mapImportRows(parsed, body.mapping)
  const validation = validateImport(mapped)
  if (validation.errors.length) throw new HttpError(400, `Import ungültig: ${validation.errors[0]}`)
  const importId = newId('imp')
  await db.insert('estimate_imports', { id: importId, org_id: session.org.id, project_id: project.id, source_type: 'csv', filename: body.filename ?? 'import.csv', status: 'imported', item_count: mapped.items.length, created_by: session.user.id, created_at: nowISO() })
  const trades = await repo.trades(session.org.id)
  const sections = await repo.sections(project.id)
  const itemIds: string[] = []
  await db.transaction(async () => {
    for (const it of mapped.items) {
      const iid = newId('ei')
      itemIds.push(iid)
      await db.insert('estimate_items', { id: iid, import_id: importId, project_id: project.id, position: it.position, description: it.description, quantity: it.quantity, unit: it.unit, trade_name: it.trade, section_name: it.section, unit_price: it.unit_price, total_price: it.total_price })
    }
  })
  if (body.mode === 'estimate') return c.json({ import_id: importId, items: mapped.items.length, tasks_created: 0 })
  // Vorgänge anlegen: je Zeile ein Vorgang (Dauer aus Spalte, sonst aus Menge/Leistung, sonst 1 AT), unter parent_id
  const bundle = (await repo.bundle(session.org.id, project.id))!
  const svc = new ProjectService(db)
  const ctx = svc.planContext(bundle)
  const siblings = bundle.tasks.filter((t) => t.parent_id === (body.parent_id ?? null))
  const created = mapped.items.map((it, i) => {
    const trade = trades.find((t) => t.name.toLowerCase() === (it.trade ?? '').toLowerCase())
    const section = sections.find((s) => s.name.toLowerCase() === (it.section ?? '').toLowerCase())
    return newTask({
      id: newId('t'), project_id: project.id, parent_id: body.parent_id ?? null, name: it.description, type: it.duration === 0 ? 'milestone' : 'task', sort_order: siblings.length + i,
      start: it.start ?? ctx.projectStart, duration: it.duration ?? (it.quantity && it.productivity_rate ? Math.max(1, Math.ceil(it.quantity / it.productivity_rate)) : 1),
      trade_id: trade?.id ?? null, section_id: section?.id ?? null, quantity: it.quantity, unit: it.unit, productivity_rate: it.productivity_rate,
      constraint_type: it.start ? 'snet' : 'asap', constraint_date: it.start ?? null,
    })
  })
  const deps = mapped.items.flatMap((it, i) => (it.predecessor_row !== null && created[it.predecessor_row] ? [newDependency({ id: newId('dep'), project_id: project.id, predecessor_id: created[it.predecessor_row].id, successor_id: created[i].id, type: it.dep_type ?? 'FS', lag_days: it.lag ?? 0 })] : []))
  const res = await svc.savePlan(session, project.id, { expected_version: body.expected_version ?? project.version, tasks: [...bundle.tasks, ...created], dependencies: [...bundle.dependencies, ...deps], reason: `Import ${body.filename ?? 'CSV'} (${created.length} Vorgänge)`, source: 'IMPORT' })
  await db.transaction(async () => {
    for (let i = 0; i < created.length; i++) await db.insert('task_estimate_links', { task_id: created[i].id, estimate_item_id: itemIds[i] })
  })
  return c.json({ import_id: importId, items: mapped.items.length, tasks_created: created.length, version: res.version })
})

// ---------------------------------------------------------------- Erfahrungswerte (lernfähige Datenbasis)
v1Routes.get('/analytics/durations', async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const rows = await db.all<Row>(
    `SELECT t.name, t.trade_id, t.duration, t.actual_duration, t.quantity, t.unit, t.productivity_rate, t.actual_start, p.name AS project_name, p.project_type,
            (SELECT reason FROM delay_events d WHERE d.task_id = t.id ORDER BY created_at DESC LIMIT 1) AS delay_reason
     FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE p.org_id = ? AND t.status = 'done' AND t.type = 'task' AND t.actual_duration IS NOT NULL`,
    s.org.id,
  )
  const byTrade = new Map<string, { trade_id: string | null; count: number; planned: number; actual: number; delayed: number }>()
  for (const r of rows) {
    const key = String(r.trade_id ?? '')
    const e = byTrade.get(key) ?? { trade_id: (r.trade_id as string) ?? null, count: 0, planned: 0, actual: 0, delayed: 0 }
    e.count++
    e.planned += Number(r.duration)
    e.actual += Number(r.actual_duration)
    if (r.delay_reason) e.delayed++
    byTrade.set(key, e)
  }
  return c.json({ records: rows, by_trade: [...byTrade.values()].map((e) => ({ ...e, ratio: e.planned ? Math.round((e.actual / e.planned) * 100) / 100 : null })) })
})

// ---------------------------------------------------------------- Bestätigungen (intern sichtbar)
v1Routes.get('/projects/:id/confirmations', async (c) => {
  await requireProject(c, c.req.param('id'))
  return c.json(await c.get('db').all('SELECT * FROM trade_confirmations WHERE project_id = ? ORDER BY created_at DESC', c.req.param('id')))
})

export function proposalNotification(db: AppEnv['Variables']['db'], orgId: string, projectId: string, projectName: string, taskName: string, from: string, proposedStart: string | null, comment: string) {
  pushNotification(db, {
    org_id: orgId, project_id: projectId, type: 'info', severity: 'warning', title: `Terminvorschlag von ${from}`,
    message: `${projectName}: „${taskName}“${proposedStart ? ` – Start ${formatDate(proposedStart)} vorgeschlagen` : ''}${comment ? ` – ${comment}` : ''} (${formatDate(todayISO())})`,
  })
}
