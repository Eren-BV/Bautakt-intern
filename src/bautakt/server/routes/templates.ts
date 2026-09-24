/**
 * Vorlagen: mitgelieferte (org_id NULL, nur lesbar) und eigene (org-gebunden).
 * Eigene Vorlagen entstehen aus einem Projekt ("Als Vorlage speichern"), als Kopie
 * einer anderen Vorlage oder leer; sie sind vollständig editierbar.
 */

import { Hono } from 'hono'
import { HttpError, requireCap, type AppEnv } from '../auth.ts'
import { newId, nowISO } from '../db.ts'
import { Repo } from '../repo.ts'
import type { ProjectTemplate, TemplateTask } from '../../shared/types.ts'
import { planToTemplateTasks } from '../../shared/templates/instantiate.ts'

export const templateRoutes = new Hono<AppEnv>()

templateRoutes.get('/templates', async (c) => {
  const s = c.get('session')
  const repo = new Repo(c.get('db'))
  const templates = await repo.templates(s.org.id)
  const out = await Promise.all(templates.map(async (t) => ({ ...t, task_count: (await repo.templateTasks(t.id)).length })))
  return c.json(out)
})

templateRoutes.get('/templates/:id', async (c) => {
  const s = c.get('session')
  const repo = new Repo(c.get('db'))
  const tpl = await repo.template(s.org.id, c.req.param('id'))
  if (!tpl) throw new HttpError(404, 'Vorlage nicht gefunden.')
  return c.json({ template: tpl, tasks: await repo.templateTasks(tpl.id) })
})

templateRoutes.post('/templates', requireCap('templates.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const repo = new Repo(db)
  const body = await c.req.json<{ name: string; description?: string; planning_kind?: ProjectTemplate['planning_kind']; project_type?: string | null; construction_method?: string | null; from_project_id?: string; copy_of?: string; tasks?: TemplateTask[] }>()
  if (!body.name?.trim()) throw new HttpError(400, 'Name ist erforderlich.')
  const id = newId('tpl')
  const tpl: ProjectTemplate = {
    id, org_id: s.org.id, name: body.name.trim(), description: body.description ?? '', planning_kind: body.planning_kind ?? 'construction', project_type: (body.project_type ?? null) as ProjectTemplate['project_type'],
    construction_method: (body.construction_method ?? null) as ProjectTemplate['construction_method'], is_builtin: false, created_at: nowISO(),
  }
  let tasks: TemplateTask[] = []
  if (body.from_project_id) {
    const bundle = await repo.bundle(s.org.id, body.from_project_id)
    if (!bundle) throw new HttpError(404, 'Projekt nicht gefunden.')
    tasks = planToTemplateTasks(id, bundle.tasks, bundle.dependencies, await repo.trades(s.org.id), () => newId('tt'))
    tpl.project_type = bundle.project.project_type
    tpl.construction_method = bundle.project.construction_method
    tpl.planning_kind = bundle.project.planning_kind
  } else if (body.copy_of) {
    const src = await repo.template(s.org.id, body.copy_of)
    if (!src) throw new HttpError(404, 'Vorlage nicht gefunden.')
    const srcTasks = await repo.templateTasks(src.id)
    tasks = srcTasks.map((t) => ({ ...t, id: newId('tt'), template_id: id }))
    tpl.planning_kind = body.planning_kind ?? src.planning_kind
    tpl.project_type = tpl.project_type ?? src.project_type
    tpl.construction_method = tpl.construction_method ?? src.construction_method
    if (!tpl.description) tpl.description = src.description
  } else if (body.tasks) {
    tasks = body.tasks.map((t, i) => ({ ...t, id: newId('tt'), template_id: id, sort_order: i }))
  }
  await db.transaction(async () => {
    await db.insert('project_templates', tpl)
    for (const t of tasks) await db.insert('template_tasks', t)
  })
  return c.json({ template: tpl, tasks }, 201)
})

templateRoutes.put('/templates/:id', requireCap('templates.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const repo = new Repo(db)
  const tpl = await repo.template(s.org.id, c.req.param('id'))
  if (!tpl) throw new HttpError(404, 'Vorlage nicht gefunden.')
  if (tpl.is_builtin) throw new HttpError(403, 'Mitgelieferte Vorlagen können nicht geändert werden – bitte zuerst kopieren.')
  const body = await c.req.json<{ name?: string; description?: string; project_type?: string | null; construction_method?: string | null; tasks?: TemplateTask[] }>()
  await db.transaction(async () => {
    const patch: Record<string, unknown> = {}
    for (const k of ['name', 'description', 'project_type', 'construction_method'] as const) if (body[k] !== undefined) patch[k] = body[k]
    await db.update('project_templates', tpl.id, patch)
    if (body.tasks) {
      const keys = new Set(body.tasks.map((t) => t.key))
      await db.run('DELETE FROM template_tasks WHERE template_id = ?', tpl.id)
      for (const [i, t] of body.tasks.entries()) {
        await db.insert('template_tasks', {
          id: t.id?.startsWith('tt_') ? t.id : newId('tt'), template_id: tpl.id, key: t.key, parent_key: t.parent_key && keys.has(t.parent_key) ? t.parent_key : null,
          name: t.name, type: t.type, duration: t.type === 'milestone' ? 0 : Math.max(1, Number(t.duration) | 0), trade_name: t.trade_name ?? null, sort_order: i,
          dependencies: (t.dependencies ?? []).filter((d) => keys.has(d.predecessor_key)),
        })
      }
    }
  })
  return c.json({ template: await repo.template(s.org.id, tpl.id), tasks: await repo.templateTasks(tpl.id) })
})

templateRoutes.delete('/templates/:id', requireCap('templates.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  await db.run('DELETE FROM project_templates WHERE id = ? AND org_id = ? AND is_builtin = 0', c.req.param('id'), s.org.id)
  return c.json({ ok: true })
})
