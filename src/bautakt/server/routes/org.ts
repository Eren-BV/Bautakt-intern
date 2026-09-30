/**
 * Organisations-Stammdaten: Mitglieder, Kategorien, Firmen, Ressourcen, Kalender,
 * Benachrichtigungen. Alles strikt auf die Organisation der Sitzung begrenzt.
 */

import { Hono } from 'hono'
import { HttpError, requireCap, hashPassword, type AppEnv } from '../auth.ts'
import { newId, nowISO } from '../db.ts'
import { Repo } from '../repo.ts'
import type { Contact, OrgData, OrgRole } from '../../shared/types.ts'
import type { Db } from '../db.ts'
import { ROLES } from '../../shared/permissions.ts'
import { HOLIDAY_REGIONS } from '../../shared/engine/holidays.ts'
import { analyzeProject, resourceConflicts } from '../../shared/engine/analysis.ts'
import { refreshAssignmentNotifications, refreshProjectNotifications } from '../services/notificationService.ts'

export const orgRoutes = new Hono<AppEnv>()

orgRoutes.get('/org', async (c) => {
  const s = c.get('session')
  const repo = new Repo(c.get('db'))
  const data: OrgData = {
    org: (await repo.organization(s.org.id)) ?? s.org,
    trades: await repo.trades(s.org.id),
    companies: await repo.companies(s.org.id),
    contacts: await repo.contacts(s.org.id),
    resources: await repo.resources(s.org.id),
    members: await repo.members(s.org.id),
    calendars: await repo.calendars(s.org.id),
    exceptions: await repo.exceptions(s.org.id),
  }
  return c.json(data)
})

orgRoutes.patch('/org', requireCap('org.manage'), async (c) => {
  const s = c.get('session')
  const body = await c.req.json<{ name?: string; holiday_region?: string }>()
  const patch: Record<string, unknown> = {}
  if (body.name?.trim()) patch.name = body.name.trim()
  if (body.holiday_region && HOLIDAY_REGIONS.some((r) => r.code === body.holiday_region)) patch.holiday_region = body.holiday_region
  if (Object.keys(patch).length) await c.get('db').update('organizations', s.org.id, patch)
  return c.json({ ok: true })
})

// ---- Mitglieder
orgRoutes.post('/org/members', requireCap('org.members.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const body = await c.req.json<{ email: string; name: string; role: OrgRole; password?: string }>()
  if (!body.email?.includes('@') || !body.name?.trim()) throw new HttpError(400, 'Name und E-Mail sind erforderlich.')
  if (!ROLES.includes(body.role)) throw new HttpError(400, 'Ungültige Rolle.')
  if (body.role === 'owner' && s.role !== 'owner') throw new HttpError(403, 'Nur der Inhaber kann weitere Inhaber ernennen.')
  let user = await db.get<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower(?)', body.email.trim())
  const passwordHash = user ? null : await hashPassword(body.password || 'willkommen1')
  await db.transaction(async () => {
    if (!user) {
      const id = newId('usr')
      await db.insert('users', { id, email: body.email.trim(), name: body.name.trim(), password_hash: passwordHash, created_at: nowISO() })
      user = { id }
    }
    await db.upsert('organization_members', { org_id: s.org.id, user_id: user!.id, role: body.role }, ['org_id', 'user_id'])
  })
  return c.json(await new Repo(db).members(s.org.id))
})

orgRoutes.patch('/org/members/:userId', requireCap('org.members.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const body = await c.req.json<{ role?: OrgRole; responsibility_areas?: string[] }>()
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) throw new HttpError(400, 'Ungültige Rolle.')
    if (body.role === 'owner' && s.role !== 'owner') throw new HttpError(403, 'Nur der Inhaber kann weitere Inhaber ernennen.')
    await db.run('UPDATE organization_members SET role = ? WHERE org_id = ? AND user_id = ?', body.role, s.org.id, c.req.param('userId'))
  }
  if (body.responsibility_areas !== undefined) {
    const areas = body.responsibility_areas.map((a) => a.trim()).filter(Boolean).slice(0, 20)
    await db.run('UPDATE organization_members SET responsibility_areas = ? WHERE org_id = ? AND user_id = ?', JSON.stringify(areas), s.org.id, c.req.param('userId'))
  }
  return c.json(await new Repo(db).members(s.org.id))
})

orgRoutes.delete('/org/members/:userId', requireCap('org.members.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  if (c.req.param('userId') === s.user.id) throw new HttpError(400, 'Sie können sich nicht selbst entfernen.')
  await db.run('DELETE FROM organization_members WHERE org_id = ? AND user_id = ?', s.org.id, c.req.param('userId'))
  return c.json(await new Repo(db).members(s.org.id))
})

// ---- Kategorien / Firmen / Ressourcen (generisches CRUD mit org-Bindung)
for (const [path, table, cap] of [
  ['trades', 'trades', 'resources.manage'],
  ['companies', 'companies', 'resources.manage'],
  ['resources', 'resources', 'resources.manage'],
] as const) {
  orgRoutes.post(`/${path}`, requireCap(cap), async (c) => {
    const s = c.get('session')
    const db = c.get('db')
    const body = await c.req.json<Record<string, unknown>>()
    if (!String(body.name ?? '').trim()) throw new HttpError(400, 'Name ist erforderlich.')
    const id = newId(path.slice(0, 2))
    const { org_id: _o, id: _i, trade_ids, ...rest } = body
    await db.transaction(async () => {
      await db.insert(table, { ...rest, id, org_id: s.org.id })
      if (table === 'companies') await syncCompanyTrades(db, id, trade_ids, rest.trade_id as string | null)
    })
    return c.json(table === 'companies' ? (await new Repo(db).companies(s.org.id)).find((x) => x.id === id) : await db.get(`SELECT * FROM ${table} WHERE id = ?`, id))
  })
  orgRoutes.patch(`/${path}/:id`, requireCap(cap), async (c) => {
    const s = c.get('session')
    const db = c.get('db')
    const body = await c.req.json<Record<string, unknown>>()
    const { org_id: _o, id: _i, trade_ids, ...patch } = body
    const exists = await db.get(`SELECT id FROM ${table} WHERE id = ? AND org_id = ?`, c.req.param('id'), s.org.id)
    if (!exists) throw new HttpError(404, 'Nicht gefunden.')
    await db.transaction(async () => {
      if (Object.keys(patch).length) await db.update(table, c.req.param('id'), patch)
      if (table === 'companies' && trade_ids !== undefined) await syncCompanyTrades(db, c.req.param('id'), trade_ids, (patch.trade_id as string | null | undefined) ?? null)
    })
    return c.json(table === 'companies' ? (await new Repo(db).companies(s.org.id)).find((x) => x.id === c.req.param('id')) : await db.get(`SELECT * FROM ${table} WHERE id = ?`, c.req.param('id')))
  })
  orgRoutes.delete(`/${path}/:id`, requireCap(cap), async (c) => {
    const s = c.get('session')
    await c.get('db').run(`DELETE FROM ${table} WHERE id = ? AND org_id = ?`, c.req.param('id'), s.org.id)
    return c.json({ ok: true })
  })
}

async function syncCompanyTrades(db: Db, companyId: string, tradeIds: unknown, primary: string | null) {
  const ids = new Set<string>(Array.isArray(tradeIds) ? tradeIds.filter((x): x is string => typeof x === 'string' && !!x) : [])
  if (primary) ids.add(primary)
  await db.run('DELETE FROM company_trades WHERE company_id = ?', companyId)
  for (const t of ids) await db.run('INSERT INTO company_trades (company_id, trade_id) VALUES (?, ?) ON CONFLICT DO NOTHING', companyId, t)
}

// ---- Ansprechpartner (Firma → Kontakte → E-Mail-Adressen)
orgRoutes.post('/contacts', requireCap('resources.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const body = await c.req.json<Partial<Contact>>()
  if (!String(body.name ?? '').trim()) throw new HttpError(400, 'Name ist erforderlich.')
  if (!body.company_id || !(await db.get('SELECT id FROM companies WHERE id = ? AND org_id = ?', body.company_id, s.org.id))) throw new HttpError(400, 'Firma ist erforderlich.')
  const id = newId('ct')
  await db.transaction(async () => {
    await db.insert('contacts', { id, org_id: s.org.id, company_id: body.company_id, name: body.name!.trim(), role: body.role ?? '', email: (body.email ?? '').trim().toLowerCase(), phone: body.phone ?? '', notes: body.notes ?? '', created_at: nowISO() })
    for (const p of body.project_ids ?? []) await db.run('INSERT INTO contact_projects (contact_id, project_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, p)
  })
  return c.json((await new Repo(db).contacts(s.org.id)).find((x) => x.id === id), 201)
})
orgRoutes.patch('/contacts/:id', requireCap('resources.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const body = await c.req.json<Partial<Contact>>()
  if (!(await db.get('SELECT id FROM contacts WHERE id = ? AND org_id = ?', c.req.param('id'), s.org.id))) throw new HttpError(404, 'Nicht gefunden.')
  const { id: _i, org_id: _o, project_ids, created_at: _c, ...patch } = body
  if (typeof patch.email === 'string') patch.email = patch.email.trim().toLowerCase()
  await db.transaction(async () => {
    if (Object.keys(patch).length) await db.update('contacts', c.req.param('id'), patch)
    if (project_ids) {
      await db.run('DELETE FROM contact_projects WHERE contact_id = ?', c.req.param('id'))
      for (const p of project_ids) await db.run('INSERT INTO contact_projects (contact_id, project_id) VALUES (?, ?) ON CONFLICT DO NOTHING', c.req.param('id'), p)
    }
  })
  return c.json((await new Repo(db).contacts(s.org.id)).find((x) => x.id === c.req.param('id')))
})
orgRoutes.delete('/contacts/:id', requireCap('resources.manage'), async (c) => {
  const s = c.get('session')
  await c.get('db').run('DELETE FROM contacts WHERE id = ? AND org_id = ?', c.req.param('id'), s.org.id)
  return c.json({ ok: true })
})

// ---- Kalender
orgRoutes.post('/calendars', requireCap('calendar.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const body = await c.req.json<{ name: string; working_days: number[]; project_id?: string | null; trade_id?: string | null; company_id?: string | null; holiday_region?: string | null; is_default?: boolean }>()
  const id = newId('cal')
  await db.transaction(async () => {
    if (body.is_default) await db.run('UPDATE project_calendars SET is_default = 0 WHERE org_id = ?', s.org.id)
    await db.insert('project_calendars', { id, org_id: s.org.id, project_id: body.project_id ?? null, trade_id: body.trade_id ?? null, company_id: body.company_id ?? null, holiday_region: body.holiday_region ?? null, name: body.name, working_days: body.working_days ?? [1, 2, 3, 4, 5], is_default: !!body.is_default })
  })
  return c.json(await new Repo(db).calendars(s.org.id))
})

orgRoutes.patch('/calendars/:id', requireCap('calendar.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const body = await c.req.json<{ name?: string; working_days?: number[]; is_default?: boolean; project_id?: string | null; trade_id?: string | null; company_id?: string | null; holiday_region?: string | null }>()
  const exists = await db.get('SELECT id FROM project_calendars WHERE id = ? AND org_id = ?', c.req.param('id'), s.org.id)
  if (!exists) throw new HttpError(404, 'Kalender nicht gefunden.')
  await db.transaction(async () => {
    if (body.is_default) await db.run('UPDATE project_calendars SET is_default = 0 WHERE org_id = ?', s.org.id)
    await db.update('project_calendars', c.req.param('id'), body)
  })
  return c.json(await new Repo(db).calendars(s.org.id))
})

orgRoutes.delete('/calendars/:id', requireCap('calendar.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  await db.run('DELETE FROM project_calendars WHERE id = ? AND org_id = ? AND is_default = 0', c.req.param('id'), s.org.id)
  return c.json(await new Repo(db).calendars(s.org.id))
})

orgRoutes.post('/calendars/:id/exceptions', requireCap('calendar.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const body = await c.req.json<{ date: string; type: string; name: string } | { items: { date: string; type: string; name: string }[] }>()
  const exists = await db.get('SELECT id FROM project_calendars WHERE id = ? AND org_id = ?', c.req.param('id'), s.org.id)
  if (!exists) throw new HttpError(404, 'Kalender nicht gefunden.')
  const items = 'items' in body ? body.items : [body]
  await db.transaction(async () => {
    for (const it of items) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date)) throw new HttpError(400, 'Ungültiges Datum.')
      await db.run('DELETE FROM calendar_exceptions WHERE calendar_id = ? AND date = ?', c.req.param('id'), it.date)
      await db.insert('calendar_exceptions', { id: newId('ex'), calendar_id: c.req.param('id'), date: it.date, type: it.type, name: it.name ?? '' })
    }
  })
  return c.json(await new Repo(db).exceptions(s.org.id))
})

orgRoutes.delete('/calendars/:id/exceptions/:exId', requireCap('calendar.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  await db.run(
    'DELETE FROM calendar_exceptions WHERE id = ? AND calendar_id IN (SELECT id FROM project_calendars WHERE id = ? AND org_id = ?)',
    c.req.param('exId'), c.req.param('id'), s.org.id,
  )
  return c.json(await new Repo(db).exceptions(s.org.id))
})

// ---- Ressourcenkonflikte über alle aktiven Projekte
orgRoutes.get('/resources/conflicts', async (c) => {
  const s = c.get('session')
  const repo = new Repo(c.get('db'))
  const resources = await repo.resources(s.org.id)
  const activeProjects = (await repo.projects(s.org.id)).filter((p) => p.state === 'active')
  const rawBundles = await Promise.all(activeProjects.map((p) => repo.bundle(s.org.id, p.id)))
  const bundles = rawBundles
    .map((b) => b!)
    .map((b) => ({ project: b.project, tasks: b.tasks, sched: analyzeProject(b).current, assignments: b.assignments }))
  return c.json(resourceConflicts(resources, bundles))
})

// ---- Benachrichtigungen
orgRoutes.get('/notifications', async (c) => {
  const s = c.get('session')
  const repo = new Repo(c.get('db'))
  // Zustandsbasierte Meldungen (Meilenstein bald, überfällig, Abweichung) bei jedem Abruf prüfen
  for (const p of await repo.projects(s.org.id)) if (p.state === 'active') refreshProjectNotifications(c.get('db'), s.org.id, (await repo.bundle(s.org.id, p.id))!)
  await refreshAssignmentNotifications(c.get('db'), s.org.id)
  return c.json(await repo.notifications(s.org.id, s.user.id))
})
orgRoutes.post('/notifications/:id/read', async (c) => {
  const s = c.get('session')
  await c.get('db').run('UPDATE notifications SET read_at = ? WHERE id = ? AND org_id = ?', nowISO(), c.req.param('id'), s.org.id)
  return c.json({ ok: true })
})
orgRoutes.post('/notifications/read-all', async (c) => {
  const s = c.get('session')
  await c.get('db').run('UPDATE notifications SET read_at = ? WHERE org_id = ? AND read_at IS NULL AND (user_id IS NULL OR user_id = ?)', nowISO(), s.org.id, s.user.id)
  return c.json({ ok: true })
})
