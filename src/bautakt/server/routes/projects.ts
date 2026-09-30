/**
 * Projekt-Routen: Liste mit Kennzahlen, Anlegen (Wizard), Bundle laden, Plan speichern,
 * Vor-Ort-Updates, Baselines, Historie, Szenarien, Tagesansicht, Portfolio.
 */

import { Hono } from 'hono'
import { HOLIDAY_REGIONS } from '../../shared/engine/holidays.ts'
import { HttpError, requireCap, type AppEnv } from '../auth.ts'
import { newId, nowISO } from '../db.ts'
import { Repo } from '../repo.ts'
import { ProjectService } from '../services/projectService.ts'
import type { CreateProjectRequest, Project, ProjectGroup, SavePlanRequest, Scenario, SiteUpdateRequest, Task, TaskDependency } from '../../shared/types.ts'
import { analyzeProject, tasksOnDate } from '../../shared/engine/analysis.ts'
import { taskReadiness } from '../../shared/engine/readiness.ts'
import { recompute } from '../../shared/engine/operations.ts'
import { todayISO } from '../../shared/engine/dates.ts'

export const projectRoutes = new Hono<AppEnv>()

const svc = (c: { get: (k: 'db') => AppEnv['Variables']['db'] }) => new ProjectService(c.get('db'))

projectRoutes.get('/projects', async (c) => {
  const s = c.get('session')
  return c.json(await svc(c).summaries(s.org.id, c.req.query('today') || undefined))
})

// ---- Sammelstelle: Projekte eines größeren Vorhabens gruppieren (rein organisatorisch)
projectRoutes.get('/project-groups', async (c) => {
  const s = c.get('session')
  return c.json(await new Repo(c.get('db')).projectGroups(s.org.id))
})
projectRoutes.post('/project-groups', requireCap('project.create'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const body = await c.req.json<{ name: string }>()
  if (!body.name?.trim()) throw new HttpError(400, 'Name ist erforderlich.')
  const now = nowISO()
  const group: ProjectGroup = { id: newId('pg'), org_id: s.org.id, name: body.name.trim(), sort_order: 0, created_at: now, updated_at: now }
  await db.insert('project_groups', group)
  return c.json(await new Repo(db).projectGroups(s.org.id), 201)
})
projectRoutes.patch('/project-groups/:id', requireCap('project.create'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const body = await c.req.json<{ name?: string }>()
  const patch: Record<string, unknown> = { updated_at: nowISO() }
  if (body.name !== undefined) {
    if (!body.name.trim()) throw new HttpError(400, 'Name ist erforderlich.')
    patch.name = body.name.trim()
  }
  await db.update('project_groups', c.req.param('id'), patch)
  return c.json(await new Repo(db).projectGroups(s.org.id))
})
projectRoutes.delete('/project-groups/:id', requireCap('project.create'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  await db.run('UPDATE projects SET group_id = NULL WHERE group_id = ? AND org_id = ?', c.req.param('id'), s.org.id)
  await db.run('DELETE FROM project_groups WHERE id = ? AND org_id = ?', c.req.param('id'), s.org.id)
  return c.json(await new Repo(db).projectGroups(s.org.id))
})

projectRoutes.post('/projects', requireCap('project.create'), async (c) => {
  const s = c.get('session')
  const body = await c.req.json<CreateProjectRequest>()
  if (!body.name?.trim()) throw new HttpError(400, 'Projektname ist erforderlich.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(body.target_end_date)) throw new HttpError(400, 'Ungültige Termine.')
  if (body.target_end_date < body.start_date) throw new HttpError(400, 'Fertigstellung liegt vor dem Baustart.')
  const project = await svc(c).createProject(s, body)
  return c.json(project, 201)
})

projectRoutes.get('/projects/:id', async (c) => {
  const s = c.get('session')
  const bundle = await new Repo(c.get('db')).bundle(s.org.id, c.req.param('id'))
  if (!bundle) throw new HttpError(404, 'Projekt nicht gefunden.')
  return c.json(bundle)
})

projectRoutes.patch('/projects/:id', requireCap('project.edit'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const repo = new Repo(db)
  const project = await repo.project(s.org.id, c.req.param('id'))
  if (!project) throw new HttpError(404, 'Projekt nicht gefunden.')
  const body = await c.req.json<Partial<Project> & { shift_tasks?: boolean }>()
  const allowed: (keyof Project)[] = ['number', 'name', 'customer', 'address', 'city', 'project_type', 'construction_method', 'start_date', 'target_end_date', 'area_sqm', 'floors', 'has_basement', 'project_manager_id', 'site_manager_id', 'state', 'calendar_id', 'planning_kind', 'holiday_region', 'group_id']
  const patch: Record<string, unknown> = {}
  for (const k of allowed) if (k in body) patch[k] = body[k]
  if (typeof patch.holiday_region === 'string' && !HOLIDAY_REGIONS.some((r) => r.code === patch.holiday_region)) throw new HttpError(400, 'Unbekannte Feiertagsregion.')
  if (typeof patch.planning_kind === 'string' && !['free', 'development', 'construction', 'process'].includes(patch.planning_kind)) throw new HttpError(400, 'Ungültige Planungsart.')
  patch.updated_at = nowISO()
  await db.transaction(async () => {
    await db.update('projects', project.id, patch)
    if (body.project_manager_id) await db.upsert('project_members', { project_id: project.id, user_id: body.project_manager_id, role: 'project_manager' }, ['project_id', 'user_id'])
    if (body.site_manager_id) await db.upsert('project_members', { project_id: project.id, user_id: body.site_manager_id, role: 'site_manager' }, ['project_id', 'user_id'])
  })
  if (body.start_date && body.start_date !== project.start_date && body.shift_tasks) await svc(c).shiftProjectStart(s, project.id, project.start_date, body.start_date)
  else if (body.start_date || body.calendar_id !== undefined || body.holiday_region !== undefined) await svc(c).recomputeAndPersist(s.org.id, project.id)
  return c.json(await repo.project(s.org.id, project.id))
})

projectRoutes.delete('/projects/:id', requireCap('project.delete'), async (c) => {
  const s = c.get('session')
  await c.get('db').run('DELETE FROM projects WHERE id = ? AND org_id = ?', c.req.param('id'), s.org.id)
  return c.json({ ok: true })
})

// ---- Plan (Bulk)
projectRoutes.put('/projects/:id/plan', requireCap('plan.edit'), async (c) => {
  const s = c.get('session')
  const body = await c.req.json<SavePlanRequest>()
  if (!Array.isArray(body.tasks) || !Array.isArray(body.dependencies)) throw new HttpError(400, 'Ungültiger Plan.')
  return c.json(await svc(c).savePlan(s, c.req.param('id'), body))
})

projectRoutes.get('/projects/:id/history', async (c) => {
  const s = c.get('session')
  const repo = new Repo(c.get('db'))
  if (!(await repo.project(s.org.id, c.req.param('id')))) throw new HttpError(404, 'Projekt nicht gefunden.')
  const [history, delays, updates] = await Promise.all([
    repo.history(c.req.param('id')),
    repo.delays(c.req.param('id')),
    repo.progressUpdates(c.req.param('id')),
  ])
  return c.json({ history, delays, updates })
})

// ---- Vor-Ort-Update
projectRoutes.post('/projects/:id/tasks/:taskId/site-update', requireCap('site.update'), async (c) => {
  const s = c.get('session')
  const body = await c.req.json<SiteUpdateRequest>()
  if (!['on_track', 'at_risk', 'delayed', 'done'].includes(body.flag)) throw new HttpError(400, 'Ungültige Aktion.')
  return c.json(await svc(c).siteUpdate(s, c.req.param('id'), c.req.param('taskId'), body))
})

// ---- Baselines
projectRoutes.post('/projects/:id/baselines', requireCap('baseline.save'), async (c) => {
  const s = c.get('session')
  const body = await c.req.json<{ name?: string }>().catch(() => ({ name: '' }))
  return c.json(await svc(c).saveBaseline(s, c.req.param('id'), body.name ?? ''), 201)
})
projectRoutes.post('/projects/:id/baselines/:bid/activate', requireCap('baseline.save'), async (c) => {
  const s = c.get('session')
  await svc(c).activateBaseline(s.org.id, c.req.param('id'), c.req.param('bid'))
  return c.json({ ok: true })
})
projectRoutes.delete('/projects/:id/baselines/:bid', requireCap('baseline.save'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  if (!(await new Repo(db).project(s.org.id, c.req.param('id')))) throw new HttpError(404, 'Projekt nicht gefunden.')
  await db.run('DELETE FROM baselines WHERE id = ? AND project_id = ?', c.req.param('bid'), c.req.param('id'))
  return c.json({ ok: true })
})

// ---- Projekt kopieren (ganzer Plan oder ausgewählte Vorgänge) als neues Projekt
projectRoutes.post('/projects/:id/duplicate', requireCap('project.create'), async (c) => {
  const s = c.get('session')
  const body = await c.req.json<{ name?: string; number?: string; start_date?: string; task_ids?: string[]; reset_progress?: boolean }>()
  const p = await svc(c).duplicateProject(s, c.req.param('id'), body)
  return c.json(p, 201)
})

// ---- Szenarien (Was-wäre-wenn): Kopie des Plans, unabhängig editierbar, später übernehmbar
projectRoutes.get('/projects/:id/scenarios', async (c) => {
  const s = c.get('session')
  const repo = new Repo(c.get('db'))
  if (!(await repo.project(s.org.id, c.req.param('id')))) throw new HttpError(404, 'Projekt nicht gefunden.')
  return c.json(await repo.scenarios(c.req.param('id')))
})
projectRoutes.post('/projects/:id/scenarios', requireCap('scenario.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const repo = new Repo(db)
  const bundle = await repo.bundle(s.org.id, c.req.param('id'))
  if (!bundle) throw new HttpError(404, 'Projekt nicht gefunden.')
  const body = await c.req.json<{ name: string; description?: string; origin?: Scenario['origin']; proposal_id?: string | null; tasks?: Scenario['tasks']; dependencies?: Scenario['dependencies']; meta?: Scenario['meta'] }>()
  const sc: Scenario = {
    id: newId('sc'), project_id: bundle.project.id, name: body.name || 'Szenario', description: body.description ?? '',
    created_at: nowISO(), created_by: s.user.id, origin: body.origin ?? 'manual', proposal_id: body.proposal_id ?? null, meta: body.meta ?? {},
    tasks: body.tasks ?? bundle.tasks, dependencies: body.dependencies ?? bundle.dependencies,
  }
  await db.insert('scenarios', sc)
  return c.json(sc, 201)
})
projectRoutes.put('/projects/:id/scenarios/:sid', requireCap('scenario.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const repo = new Repo(db)
  const bundle = await repo.bundle(s.org.id, c.req.param('id'))
  if (!bundle) throw new HttpError(404, 'Projekt nicht gefunden.')
  const body = await c.req.json<{ name?: string; description?: string; tasks?: Task[]; dependencies?: TaskDependency[] }>()
  const patch: Record<string, unknown> = {}
  if (body.name !== undefined) patch.name = body.name
  if (body.description !== undefined) patch.description = body.description
  if (body.tasks && body.dependencies) {
    const ctx = new ProjectService(db).planContext(bundle)
    const st = recompute({ tasks: body.tasks, dependencies: body.dependencies }, ctx).state
    patch.tasks = st.tasks
    patch.dependencies = st.dependencies
  }
  await db.update('scenarios', c.req.param('sid'), patch)
  const scenarios = await repo.scenarios(bundle.project.id)
  return c.json(scenarios.find((x) => x.id === c.req.param('sid')))
})
projectRoutes.delete('/projects/:id/scenarios/:sid', requireCap('scenario.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  if (!(await new Repo(db).project(s.org.id, c.req.param('id')))) throw new HttpError(404, 'Projekt nicht gefunden.')
  await db.run('DELETE FROM scenarios WHERE id = ? AND project_id = ?', c.req.param('sid'), c.req.param('id'))
  return c.json({ ok: true })
})
/** Szenario übernehmen: wird zum echten Plan (mit Historie) */
projectRoutes.post('/projects/:id/scenarios/:sid/apply', requireCap('plan.edit'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const repo = new Repo(db)
  const project = await repo.project(s.org.id, c.req.param('id'))
  if (!project) throw new HttpError(404, 'Projekt nicht gefunden.')
  const scenarios = await repo.scenarios(project.id)
  const sc = scenarios.find((x) => x.id === c.req.param('sid'))
  if (!sc) throw new HttpError(404, 'Szenario nicht gefunden.')
  const res = await new ProjectService(db).savePlan(s, project.id, { expected_version: project.version, tasks: sc.tasks, dependencies: sc.dependencies, reason: `Szenario übernommen: ${sc.name}` })
  await db.run('DELETE FROM scenarios WHERE id = ?', sc.id)
  return c.json(res)
})

// ---- Tagesansicht "HEUTE": laufende Vorgänge über alle aktiven Projekte, auf die der Nutzer Zugriff hat
projectRoutes.get('/site/today', async (c) => {
  const s = c.get('session')
  const repo = new Repo(c.get('db'))
  const date = c.req.query('date') || todayISO()
  const projectFilter = c.req.query('project')
  const out: { project: Project; tasks: (Task & { planned_progress: number; is_critical: boolean; readiness: ReturnType<typeof taskReadiness> })[] }[] = []
  const projects = await repo.projects(s.org.id)
  for (const p of projects) {
    if (p.state !== 'active') continue
    if (projectFilter && p.id !== projectFilter) continue
    const bundle = (await repo.bundle(s.org.id, p.id))!
    const a = analyzeProject(bundle, date)
    const list = tasksOnDate(bundle.tasks, a.current, date).map((t) => ({ ...t, planned_progress: a.current.tasks.get(t.id)!.plannedProgress, is_critical: a.current.tasks.get(t.id)!.isCritical, readiness: taskReadiness(t, bundle.tasks, bundle.dependencies, bundle.constraints) }))
    if (list.length) out.push({ project: p, tasks: list })
  }
  return c.json(out)
})

// ---- Portfolio: alle Projekte inkl. Phasen/Meilensteinen für die gemeinsame Timeline
projectRoutes.get('/portfolio', async (c) => {
  const s = c.get('session')
  const repo = new Repo(c.get('db'))
  const projects = await repo.projects(s.org.id)
  const out = await Promise.all(projects.map(async (p) => {
    const bundle = (await repo.bundle(s.org.id, p.id))!
    const a = analyzeProject(bundle)
    return {
      project: p,
      health: a.health,
      progress: a.progress,
      forecast_end: a.forecast_end,
      planned_end: a.planned_end,
      baseline_end: a.baseline_end,
      variance_days: a.variance_days,
      phases: bundle.tasks.filter((t) => t.type === 'phase' && !t.parent_id).map((t) => ({ id: t.id, name: t.name, start: t.start_date, end: t.end_date, is_critical: t.is_critical, progress: t.progress })),
      milestones: bundle.tasks.filter((t) => t.type === 'milestone').map((t) => ({ id: t.id, name: t.name, date: t.start_date, done: t.status === 'done' })),
      tasks: bundle.tasks,
      dependencies: bundle.dependencies,
      assignments: bundle.assignments,
      constraints: bundle.constraints,
      sections: bundle.sections,
    }
  }))
  return c.json(out)
})
