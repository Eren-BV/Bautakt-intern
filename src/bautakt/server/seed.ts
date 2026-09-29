/**
 * Demodaten: Organisation "Baumission GmbH" mit Nutzern aller Rollen, Gewerken, Firmen,
 * Ressourcen, Kalender (Feiertage Bayern) sowie vier Projekten. Das Hauptprojekt
 * "Doppelhaushälfte Musterstraße" wird bis zum heutigen Tag "durchgespielt": Baseline
 * eingefroren, Lieferverzug Fenster (+8 AT), erledigte Vorgänge mit Ist-Terminen, laufende
 * Vorgänge mit Fortschritt, eine gemeldete Verzögerung, Voraussetzungen, ein offener
 * Nachunternehmer-Vorschlag, ein Ressourcenkonflikt, ein Demo-Share-Link.
 */

import type { BatchStatement, Db } from './db.ts'
import { buildInsert, newId, nowISO } from './db.ts'
import { hashPassword, sha256Hex } from './auth.ts'
import { Repo } from './repo.ts'
import { ProjectService } from './services/projectService.ts'
import { pushNotification } from './services/notificationService.ts'
import { BUILTIN_TEMPLATES } from '../shared/templates/builtin.ts'
import { builtinToTemplateTasks, instantiateTemplate } from '../shared/templates/instantiate.ts'
import { BUILTIN_WORK_PACKAGES, DHH_QUANTITIES, DHH_SECTIONS } from '../shared/templates/dhh.ts'
import { builtinToWorkPackageTasks } from '../shared/templates/workPackages.ts'
import { DEFAULT_TRADES } from '../shared/labels.ts'
import { todayISO, toDayNumber, fromDayNumber, formatDate, addDays } from '../shared/engine/dates.ts'
import { holidaysFor } from '../shared/engine/holidays.ts'
import { RuleBasedEmailAnalyzer } from '../shared/integrations/email/rulesAnalyzer.ts'
import { buildEmailContext } from './services/emailService.ts'
import { SAMPLE_BUILDFLOW_PROCESS } from '../shared/integrations/buildflow/sample.ts'
import { recompute, setDuration, updateTaskFields, type PlanState } from '../shared/engine/operations.ts'
import type { OrgRole, Session, Task } from '../shared/types.ts'

export const DEMO_PASSWORD = 'demo1234'
export const DEMO_SHARE_TOKEN = 'demo-fliesen-rossi'

export async function seedBuiltinTemplates(db: Db): Promise<void> {
  for (const tpl of BUILTIN_TEMPLATES) {
    const exists = await db.get('SELECT id FROM project_templates WHERE id = ?', tpl.id)
    if (exists) continue
    await db.transaction(async () => {
      await db.insert('project_templates', {
        id: tpl.id, org_id: null, name: tpl.name, description: tpl.description, planning_kind: tpl.planning_kind, project_type: tpl.project_type,
        construction_method: tpl.construction_method, is_builtin: true, created_at: nowISO(),
      })
      for (const tt of builtinToTemplateTasks(tpl)) await db.insert('template_tasks', tt)
    })
  }
  for (const wp of BUILTIN_WORK_PACKAGES) {
    if (await db.get('SELECT id FROM work_package_templates WHERE id = ?', wp.id)) continue
    await db.transaction(async () => {
      await db.insert('work_package_templates', { id: wp.id, org_id: null, name: wp.name, description: wp.description, is_builtin: true, created_at: nowISO() })
      for (const t of builtinToWorkPackageTasks(wp.id)) await db.insert('work_package_tasks', t)
    })
  }
}

export async function seedDemoOrg(db: Db): Promise<void> {
  if (await db.get('SELECT id FROM organizations WHERE slug = ?', 'baumission')) return
  console.log('[seed] Demo-Organisation wird angelegt …')
  const now = nowISO()
  const today = todayISO()
  const orgId = 'org_musterbau'
  await db.insert('organizations', { id: orgId, name: 'Baumission GmbH', slug: 'baumission', holiday_region: 'DE-BY', created_at: now })

  const users: { id: string; name: string; email: string; role: OrgRole }[] = [
    { id: 'usr_berger', name: 'Dino-Denis Sejdinovic', email: 'dino.sejdinovic@baumission.de', role: 'owner' },
    { id: 'usr_schmidt', name: 'Anna Schmidt', email: 'anna.schmidt@baumission.de', role: 'admin' },
    { id: 'usr_krueger', name: 'Sabine Krüger', email: 'sabine.krueger@baumission.de', role: 'project_manager' },
    { id: 'usr_mustermann', name: 'Max Mustermann', email: 'max.mustermann@baumission.de', role: 'site_manager' },
    { id: 'usr_wagner', name: 'Lukas Wagner', email: 'lukas.wagner@baumission.de', role: 'site_manager' },
    { id: 'usr_meier', name: 'Julia Meier', email: 'julia.meier@baumission.de', role: 'employee' },
    { id: 'usr_mueller', name: 'Firma Müller (NU)', email: 'info@mueller-bau.de', role: 'subcontractor' },
    { id: 'usr_bauherr', name: 'Familie Huber (Bauherr)', email: 'huber@example.com', role: 'viewer' },
  ]
  const pw = await hashPassword(DEMO_PASSWORD)
  for (const u of users) {
    await db.insert('users', { id: u.id, email: u.email, name: u.name, password_hash: pw, created_at: now })
    await db.insert('organization_members', { org_id: orgId, user_id: u.id, role: u.role })
  }

  // Kalender: Org-Standard Mo–Fr + Betriebsurlaub zwischen den Jahren. Gesetzliche Feiertage
  // kommen aus der Projektregion (DE-BY) und werden von der Engine berechnet, nicht gespeichert.
  const calId = 'cal_musterbau'
  await db.insert('project_calendars', { id: calId, org_id: orgId, project_id: null, trade_id: null, company_id: null, holiday_region: null, name: 'Standard Baumission (Mo–Fr)', working_days: [1, 2, 3, 4, 5], is_default: true })
  for (const y of [2025, 2026, 2027, 2028]) {
    for (let d = toDayNumber(`${y}-12-24`); d <= toDayNumber(`${y}-12-31`); d++) {
      const iso = fromDayNumber(d)
      if (!holidaysFor(y, 'DE-BY').some((h) => h.date === iso)) await db.insert('calendar_exceptions', { id: newId('ex'), calendar_id: calId, date: iso, type: 'vacation', name: 'Betriebsurlaub' })
    }
  }

  // Gewerke
  const tradeIds = new Map<string, string>()
  for (let i = 0; i < DEFAULT_TRADES.length; i++) {
    const t = DEFAULT_TRADES[i]
    const id = newId('tr')
    tradeIds.set(t.name, id)
    await db.insert('trades', { id, org_id: orgId, name: t.name, color: t.color, sort_order: i })
  }
  // Gewerks-Kalender: Estrich arbeitet auch samstags
  await db.insert('project_calendars', { id: newId('cal'), org_id: orgId, project_id: null, trade_id: tradeIds.get('Estrich'), company_id: null, holiday_region: null, name: 'Estrich (Mo–Sa)', working_days: [1, 2, 3, 4, 5, 6], is_default: false })

  // Firmen
  const companies: [string, string, string, string][] = [
    ['Müller Bau GmbH', 'Rohbau', 'Stefan Müller', '08121 4470-0'], ['Erdbau Pichler', 'Erdarbeiten', 'Josef Pichler', '08121 2231'], ['Zimmerei Holzner', 'Zimmerer', 'Georg Holzner', '08106 9977-1'],
    ['Dachdeckerei Seidl', 'Dachdecker', 'Markus Seidl', '089 4521-88'], ['Fensterbau Kraus', 'Fenster', 'Petra Kraus', '08121 7788-0'], ['Elektro Bauer', 'Elektro', 'Thomas Bauer', '089 6650-321'],
    ['SHK Huber & Sohn', 'SHK', 'Franz Huber', '08121 3399'], ['Trockenbau Wenzel', 'Trockenbau', 'Karl Wenzel', '089 1234-56'], ['Putz Novak', 'Innenputz', 'Ivo Novak', '089 8877-12'],
    ['Estrich Fink', 'Estrich', 'Rainer Fink', '08121 5533'], ['Fliesen Rossi', 'Fliesen', 'Marco Rossi', '089 7712-90'], ['Malerbetrieb Lang', 'Maler', 'Sabine Lang', '08121 9021'],
    ['Bodenstudio Weiss', 'Bodenleger', 'Tanja Weiss', '089 3311-07'], ['Schreinerei Gruber', 'Schreiner', 'Andreas Gruber', '08121 6644'], ['Gartenbau Grün', 'Außenanlagen', 'Lena Grün', '089 5590-11'],
  ]
  const companyByTrade = new Map<string, string>()
  const companyDomain = (name: string) => `${name.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}.de`
  const streets = ['Industriestraße 4', 'Gewerbering 12', 'Am Bahnhof 3', 'Hauptstraße 21', 'Werkstraße 8', 'Handwerkerhof 5']
  for (let i = 0; i < companies.length; i++) {
    const [name, trade, contact, phone] = companies[i]
    const id = newId('co')
    companyByTrade.set(tradeIds.get(trade)!, id)
    const domain = companyDomain(name)
    await db.insert('companies', { id, org_id: orgId, name, trade_id: tradeIds.get(trade), contact_name: contact, phone, email: `info@${domain}`, address: `${streets[i % streets.length]}, 8${String(5000 + i * 137).padStart(4, '0')} Umland München`, notes: '' })
    await db.insert('company_trades', { company_id: id, trade_id: tradeIds.get(trade) })
    // Ansprechpartner: Inhaber/Bauleitung mit persönlicher Adresse, Disposition mit Sammeladresse
    const [first, ...rest] = contact.split(' ')
    await db.insert('contacts', { id: newId('ct'), org_id: orgId, company_id: id, name: contact, role: 'Inhaber / Bauleitung', email: `${first.toLowerCase()}.${rest.join('').toLowerCase()}@${domain}`, phone, notes: '', created_at: now })
    if (['Maler', 'Fliesen', 'Elektro', 'SHK'].includes(trade)) await db.insert('contacts', { id: newId('ct'), org_id: orgId, company_id: id, name: 'Disposition', role: 'Disposition', email: `planung@${domain}`, phone: '', notes: '', created_at: now })
  }
  // Fensterbau Kraus: Firmenkalender mit Betriebsurlaub (Kalender-Schicht „Firma“)
  const krausId = companyByTrade.get(tradeIds.get('Fenster')!)!
  const calKraus = newId('cal')
  await db.insert('project_calendars', { id: calKraus, org_id: orgId, project_id: null, trade_id: null, company_id: krausId, holiday_region: null, name: 'Fensterbau Kraus (Betriebsurlaub)', working_days: [1, 2, 3, 4, 5], is_default: false })
  for (let d = toDayNumber('2026-08-10'); d <= toDayNumber('2026-08-21'); d++) await db.insert('calendar_exceptions', { id: newId('ex'), calendar_id: calKraus, date: fromDayNumber(d), type: 'vacation', name: 'Betriebsurlaub Kraus' })

  // Ressourcen
  const res = (id: string, name: string, type: string, trade: string | null, capacity = 1) =>
    db.insert('resources', { id, org_id: orgId, name, type, trade_id: trade ? tradeIds.get(trade) : null, company_id: null, capacity, calendar_id: null })
  await res('res_rohbau1', 'Rohbaukolonne 1', 'team', 'Rohbau')
  await res('res_rohbau2', 'Rohbaukolonne 2', 'team', 'Rohbau')
  await res('res_ausbau', 'Kolonne Ausbau', 'team', 'Trockenbau')
  await res('res_kran', 'Turmdrehkran K1', 'equipment', null)
  await res('res_bagger', 'Bagger CAT 308', 'equipment', 'Erdarbeiten')
  await res('res_polier', 'Polier Huber', 'person', 'Rohbau')

  const repo = new Repo(db)
  const svc = new ProjectService(db)
  const trades = await repo.trades(orgId)
  const session: Session = { token: '', user: { id: 'usr_krueger', email: '', name: 'Sabine Krüger', created_at: now }, org: { id: orgId, name: 'Baumission GmbH', slug: 'baumission', holiday_region: 'DE-BY', created_at: now }, role: 'project_manager' }
  const siteSession: Session = { ...session, user: { id: 'usr_mustermann', email: '', name: 'Max Mustermann', created_at: now }, role: 'site_manager' }

  const mkProject = async (p: Record<string, unknown>, sections: string[]) => {
    const id = String(p.id)
    await db.insert('projects', { state: 'active', calendar_id: null, version: 1, created_at: now, updated_at: now, org_id: orgId, has_basement: false, area_sqm: null, floors: null, planning_kind: 'construction', holiday_region: 'DE-BY', ...p })
    for (const [uid, role] of [[p.project_manager_id, 'project_manager'], [p.site_manager_id, 'site_manager']] as const) {
      if (uid) await db.insert('project_members', { project_id: id, user_id: uid, role })
    }
    const sectionByName = new Map<string, string>()
    for (let i = 0; i < sections.length; i++) {
      const name = sections[i]
      const sid = newId('sec')
      sectionByName.set(name.toLowerCase(), sid)
      await db.insert('project_sections', { id: sid, project_id: id, name, sort_order: i })
    }
    return { id, sectionByName }
  }
  const assignByTrade = (tasks: Task[], map: Record<string, { resource?: string; responsible?: string }>) =>
    tasks.map((t) => {
      const tradeName = trades.find((x) => x.id === t.trade_id)?.name ?? ''
      const cfg = map[tradeName]
      return {
        ...t,
        company_id: t.trade_id ? companyByTrade.get(t.trade_id) ?? null : null,
        resource_id: cfg?.resource ?? t.resource_id,
        responsible_user_id: cfg?.responsible ?? (tradeName === 'Bauleitung' ? 'usr_mustermann' : t.responsible_user_id),
      }
    })
  const persistConstraints = async (_projectId: string, plan: PlanState, constraints: ReturnType<typeof instantiateTemplate>['constraints']) => {
    for (const c of constraints) {
      const t = plan.tasks.find((x) => x.id === c.task_id)
      // Voraussetzungen erledigter/laufender Vorgänge gelten als erfüllt
      const status = t && (t.status === 'done' || t.status === 'in_progress') ? 'fulfilled' : c.status
      await db.insert('task_constraints', { id: newId('cs'), ...c, status, created_at: now, updated_at: now })
    }
  }

  // ------------------------------------------------------------ Projekt 1: DHH Musterstraße
  {
    const { id, sectionByName } = await mkProject({
      id: 'prj_musterstrasse', number: 'BV-2026-004', name: 'Doppelhaushälfte Musterstraße', customer: 'Familie Huber', address: 'Musterstraße 12',
      city: '85570 Markt Schwaben', project_type: 'dhh', construction_method: 'massiv', start_date: '2026-04-07', target_end_date: '2026-12-04',
      area_sqm: 148, floors: 2, has_basement: true, project_manager_id: 'usr_krueger', site_manager_id: 'usr_mustermann',
    }, DHH_SECTIONS)
    const bundle = (await repo.bundle(orgId, id))!
    const ctx = svc.planContext(bundle, today)
    const tplTasks = await repo.templateTasks('tpl_dhh_massiv')
    const inst = instantiateTemplate(tplTasks, ctx, trades, () => newId('t'), sectionByName)
    // Mengen/Leistungswerte aus der Demo-Tabelle übernehmen (Vorlagen-Key → Task via Name)
    const keyByName = new Map(tplTasks.map((tt) => [tt.name, tt.key]))
    let plan: PlanState = recompute({
      tasks: assignByTrade(inst.tasks, { Rohbau: { resource: 'res_rohbau1', responsible: 'usr_mustermann' }, Erdarbeiten: { resource: 'res_bagger' }, Trockenbau: { resource: 'res_ausbau' } }).map((t) => {
        const q = DHH_QUANTITIES[keyByName.get(t.name) ?? '']
        return q ? { ...t, quantity: q.quantity, unit: q.unit, productivity_rate: q.rate, crew_size: 1 } : t
      }),
      dependencies: inst.dependencies,
    }, ctx).state
    await persistPlan(db, id, plan)
    await db.update('projects', id, { version: 2 })
    const bl = await svc.saveBaseline(session, id, 'Baseline 1 – Auftrag')
    await db.run('UPDATE baselines SET created_at = ? WHERE id = ?', '2026-02-20T09:30:00.000Z', bl.id)
    await db.run('UPDATE change_history SET created_at = ? WHERE project_id = ?', '2026-02-20T09:30:00.000Z', id)

    // Realität: Lieferverzug Fenster → 8 Arbeitstage länger (ganze Kette verschiebt sich)
    const fenster = plan.tasks.find((t) => t.name.startsWith('Fenster'))!
    const before = plan
    plan = setDuration(plan, ctx, fenster.id, fenster.duration + 8)
    await logHistory(db, id, before, plan, siteSession, 'Lieferverzug – Fensterelemente 2 Wochen später geliefert', '2026-07-15T16:10:00.000Z', 'SITE_UPDATE')
    await db.insert('delay_events', { id: newId('dl'), project_id: id, task_id: fenster.id, user_id: 'usr_mustermann', created_at: '2026-07-15T16:10:00.000Z', reason: 'delivery', days: 8, comment: 'Fensterelemente 2 Wochen später geliefert (Hersteller).' })
    await db.insert('progress_updates', { id: newId('pu'), project_id: id, task_id: fenster.id, user_id: 'usr_mustermann', created_at: '2026-07-15T16:10:00.000Z', flag: 'delayed', progress: 0, comment: 'Fensterelemente 2 Wochen später geliefert (Hersteller).', delay_reason: 'delivery', new_forecast_end: null, attachments: [] })

    // Erledigte/laufende Vorgänge bis heute
    plan = await simulateProgress(plan, ctx, today, {
      delayed: { match: 'Trockenbau Wände', reason: 'staff', days: 2, comment: 'Trockenbaukolonne krankheitsbedingt nur mit 2 Mann – 2 Tage länger.' },
    }, db, id, siteSession)
    await persistPlan(db, id, plan)
    await persistConstraints(id, plan, inst.constraints)
    // Eine Voraussetzung ist blockiert (Bauherr): Verlegemuster Fliesen
    const fliesenWand = plan.tasks.find((t) => t.name === 'Wandfliesen Bäder')!
    await db.run("UPDATE task_constraints SET status = 'blocked', note = ?, due_date = ? WHERE task_id = ? AND type = 'approval'", 'Bauherr hat Muster noch nicht ausgewählt – Termin beim Fliesenhändler am Freitag.', fromDayNumber(toDayNumber(today) + 3), fliesenWand.id)
    await db.update('projects', id, { version: 3 })

    // Ressourcen-Zuweisung mit Einheiten (zusätzlich zur direkten Ressource am Vorgang)
    const tbDg = plan.tasks.find((t) => t.name.startsWith('Trockenbau Dachschrägen'))!
    await db.insert('resource_assignments', { id: newId('ra'), task_id: tbDg.id, resource_id: 'res_ausbau', units: 1, start_date: null, end_date: null })

    // Offener Nachunternehmer-Vorschlag: Fliesen Rossi kann erst 3 Tage später beginnen
    const sched = recompute(plan, ctx).result.tasks.get(fliesenWand.id)!
    const proposedStart = fromDayNumber(sched.calendar.addWorkdays(sched.start, 3))
    const shareId = newId('sh')
    await db.insert('share_links', {
      id: shareId, org_id: orgId, project_id: id, token_hash: await sha256Hex(DEMO_SHARE_TOKEN), scope: 'trade', trade_id: tradeIds.get('Fliesen'),
      company_id: companyByTrade.get(tradeIds.get('Fliesen')!), label: 'Gewerkeplan Fliesen Rossi', relevance: 'standard', expires_at: null, revoked_at: null, created_by: 'usr_krueger', created_at: now, last_used_at: null, use_count: 0,
    })
    await db.insert('change_proposals', {
      id: newId('cp'), project_id: id, task_id: fliesenWand.id, source: 'SUBCONTRACTOR_PROPOSAL', status: 'open', title: 'Wandfliesen Bäder: Start 3 AT später', proposed_start: proposedStart, proposed_end: null, operations: [],
      reason: 'staff', comment: 'Unsere Kolonne ist bis dahin noch auf der Baustelle Riem gebunden – Start 3 Tage später möglich.', submitted_by_name: 'Marco Rossi (Fliesen Rossi)', submitted_by_user_id: null, share_link_id: shareId,
      origin_kind: 'share_link', origin_ref: null, created_at: new Date(Date.parse(today) - 86400000).toISOString(), decided_at: null, decided_by: null, decision_note: '',
    })
    // Kontakte der beteiligten Firmen dem Projekt zuordnen (Projekt-Zuordnung eingehender E-Mails)
    for (const c of await db.all<{ id: string; company_id: string }>('SELECT id, company_id FROM contacts WHERE org_id = ?', orgId)) {
      if (plan.tasks.some((t) => t.company_id === c.company_id)) await db.insert('contact_projects', { contact_id: c.id, project_id: id })
    }
    await db.insert('trade_confirmations', { id: newId('tc'), project_id: id, share_link_id: shareId, task_id: fliesenWand.id, status: 'not_possible', proposed_start: proposedStart, comment: 'Kolonne noch in Riem gebunden.', contact_name: 'Marco Rossi', created_at: new Date(Date.parse(today) - 86400000).toISOString() })
    await pushNotification(db, { org_id: orgId, project_id: id, type: 'info', severity: 'warning', title: 'Terminvorschlag von Fliesen Rossi', message: `„Wandfliesen Bäder“: Start ${formatDate(proposedStart)} statt ${formatDate(fromDayNumber(sched.start))} (+3 AT). Bitte prüfen und entscheiden.` })
  }

  // ------------------------------------------------------------ Projekt 2: EFH Holzständer (im Plan)
  {
    const { id, sectionByName } = await mkProject({
      id: 'prj_huber', number: 'BV-2026-007', name: 'EFH Familie Wimmer', customer: 'Familie Wimmer', address: 'Am Anger 4', city: '85622 Feldkirchen',
      project_type: 'efh', construction_method: 'holzstaender', start_date: '2026-08-10', target_end_date: '2026-12-18', area_sqm: 162, floors: 2, has_basement: false,
      project_manager_id: 'usr_krueger', site_manager_id: 'usr_wagner',
    }, ['EG', 'OG', 'Dach', 'Außen'])
    const bundle = (await repo.bundle(orgId, id))!
    const ctx = svc.planContext(bundle, today)
    const inst = instantiateTemplate(await repo.templateTasks('tpl_efh_holz'), ctx, trades, () => newId('t'), sectionByName)
    let plan: PlanState = recompute({ tasks: assignByTrade(inst.tasks, { Rohbau: { resource: 'res_rohbau1', responsible: 'usr_wagner' }, Zimmerer: { responsible: 'usr_wagner' }, Erdarbeiten: { resource: 'res_bagger' }, Trockenbau: { resource: 'res_ausbau' } }), dependencies: inst.dependencies }, ctx).state
    await persistPlan(db, id, plan)
    await db.update('projects', id, { version: 2 })
    await svc.saveBaseline(session, id, 'Baseline 1 – Auftrag')
    plan = await simulateProgress(plan, ctx, today, {}, db, id, siteSession)
    await persistPlan(db, id, plan)
    await persistConstraints(id, plan, inst.constraints)
    await db.update('projects', id, { version: 3 })
  }

  // ------------------------------------------------------------ Projekt 3: Wohnung Kernsanierung (gefährdet)
  {
    const { id, sectionByName } = await mkProject({
      id: 'prj_leopold', number: 'BV-2026-009', name: 'Kernsanierung Leopoldstraße 88', customer: 'Immo Süd GmbH', address: 'Leopoldstraße 88, 3. OG', city: '80802 München',
      project_type: 'wohnung_sanierung', construction_method: 'individuell', start_date: '2026-09-01', target_end_date: '2026-11-13', area_sqm: 96, floors: 1,
      project_manager_id: 'usr_schmidt', site_manager_id: 'usr_mustermann',
    }, ['Wohnung', 'Bad'])
    const bundle = (await repo.bundle(orgId, id))!
    const ctx = svc.planContext(bundle, today)
    const inst = instantiateTemplate(await repo.templateTasks('tpl_whg_kern'), ctx, trades, () => newId('t'), sectionByName)
    let plan: PlanState = recompute({ tasks: assignByTrade(inst.tasks, { Trockenbau: { resource: 'res_ausbau' }, Rohbau: { resource: 'res_rohbau2' } }), dependencies: inst.dependencies }, ctx).state
    await persistPlan(db, id, plan)
    await db.update('projects', id, { version: 2 })
    await svc.saveBaseline(session, id, 'Baseline')
    plan = await simulateProgress(plan, ctx, today, { blocked: { match: 'SHK Rohinstallation', comment: 'Steigleitung im Bestand nicht wie im Plan – Klärung mit Planer.' } }, db, id, siteSession)
    await persistPlan(db, id, plan)
    await persistConstraints(id, plan, inst.constraints)
    await db.update('projects', id, { version: 3 })
  }

  // ------------------------------------------------------------ Projekt 4: MFH pausiert
  {
    const { id, sectionByName } = await mkProject({
      id: 'prj_gartenstadt', number: 'BV-2026-011', name: 'MFH Gartenstadt – Haus B', customer: 'Wohnbau Gartenstadt eG', address: 'Rosenweg 7', city: '85521 Ottobrunn',
      project_type: 'mfh', construction_method: 'massiv', start_date: '2026-10-05', target_end_date: '2027-06-11', area_sqm: 640, floors: 3, has_basement: true,
      project_manager_id: 'usr_krueger', site_manager_id: 'usr_wagner', state: 'paused',
    }, DHH_SECTIONS)
    const bundle = (await repo.bundle(orgId, id))!
    const ctx = svc.planContext(bundle, today)
    const inst = instantiateTemplate(await repo.templateTasks('tpl_dhh_massiv'), ctx, trades, () => newId('t'), sectionByName)
    const plan = recompute({ tasks: assignByTrade(inst.tasks, { Rohbau: { resource: 'res_rohbau2' } }), dependencies: inst.dependencies }, ctx).state
    await persistPlan(db, id, plan)
    await persistConstraints(id, plan, inst.constraints)
  }

  // ------------------------------------------------------------ Projekt 5: Projektentwicklung (kein Bauprojekt)
  {
    const { id, sectionByName } = await mkProject({
      id: 'prj_sonnenhang', number: 'PE-2026-002', name: 'Neubauprojekt Am Sonnenhang – Vorbereitung', customer: 'Baumission Projektentwicklung', address: 'Am Sonnenhang 1–5', city: '85604 Zorneding',
      project_type: 'individuell', construction_method: 'individuell', planning_kind: 'development', start_date: addDays(today, -45), target_end_date: addDays(today, 160),
      project_manager_id: 'usr_berger', site_manager_id: null,
    }, [])
    const bundle = (await repo.bundle(orgId, id))!
    const ctx = svc.planContext(bundle, today)
    const inst = instantiateTemplate(await repo.templateTasks('tpl_projektentwicklung'), ctx, trades, () => newId('t'), sectionByName)
    let plan: PlanState = recompute({ tasks: inst.tasks.map((t) => ({ ...t, responsible_user_id: 'usr_berger' })), dependencies: inst.dependencies }, ctx).state
    await persistPlan(db, id, plan)
    await db.update('projects', id, { version: 2 })
    await svc.saveBaseline(session, id, 'Baseline – Projektstart')
    plan = await simulateProgress(plan, ctx, today, {}, db, id, { ...session, user: { id: 'usr_berger', email: '', name: 'Dino-Denis Sejdinovic', created_at: now } })
    await persistPlan(db, id, plan)
    await persistConstraints(id, plan, inst.constraints)
    await db.update('projects', id, { version: 3 })
  }

  // ------------------------------------------------------------ Projekt 6: prozessbasiert aus BuildFlow (JSON-Export)
  {
    const p = await svc.createProject(session, {
      number: 'PR-2026-001', name: 'Angebots- & Vergabeprozess Gartenstadt', customer: 'Wohnbau Gartenstadt eG', address: '', city: '', project_manager_id: 'usr_krueger', site_manager_id: null,
      planning_kind: 'process', holiday_region: 'DE-BY', project_type: 'individuell', construction_method: 'individuell', start_date: addDays(today, 7), target_end_date: addDays(today, 120),
      area_sqm: null, floors: null, has_basement: false, plan_source: { kind: 'buildflow', process: SAMPLE_BUILDFLOW_PROCESS },
    })
    void p
  }

  // ------------------------------------------------------------ Eingehende E-Mail (manueller Eingang, regelbasiert analysiert)
  {
    const maler = await db.get<{ id: string; email: string; name: string }>("SELECT c.id, c.email, c.name FROM contacts c JOIN companies co ON co.id = c.company_id WHERE co.org_id = ? AND co.name = 'Malerbetrieb Lang' AND c.role LIKE 'Inhaber%'", orgId)
    const malerTask = await db.get<{ id: string; start_date: string; name: string }>("SELECT id, start_date, name FROM tasks WHERE project_id = 'prj_musterstrasse' AND name LIKE 'Maler%' AND status = 'not_started' ORDER BY start_date LIMIT 1")
    if (maler && malerTask) {
      const oldStart = malerTask.start_date
      const newStart = addDays(oldStart, 4)
      const fmt = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`
      const mail = {
        id: newId('em'), org_id: orgId, provider: 'manual', external_id: null, from_email: maler.email, from_name: maler.name, to_email: 'sabine.krueger@baumission.de',
        subject: 'Musterstraße – Malerarbeiten', body_text: `Hallo Frau Krüger,\n\nwir schaffen es leider nicht wie besprochen am ${fmt(oldStart)}. Wir können erst am ${fmt(newStart)} mit den Malerarbeiten beginnen.\n\nViele Grüße\n${maler.name}\nMalerbetrieb Lang`,
        received_at: new Date(Date.parse(today) - 3600000 * 5).toISOString(), status: 'new', analysis: null as unknown, project_id: null as string | null, proposal_id: null, created_at: now,
      }
      const analysis = new RuleBasedEmailAnalyzer().analyzeSync({ id: mail.id, provider: 'manual', external_id: null, from_email: mail.from_email, from_name: mail.from_name, to_email: mail.to_email, subject: mail.subject, body_text: mail.body_text, received_at: mail.received_at }, await buildEmailContext(db, orgId, today))
      mail.analysis = analysis
      mail.project_id = analysis.project_candidates[0]?.project_id ?? null
      mail.status = analysis.operations.length ? 'analyzed' : 'new'
      await db.insert('inbound_emails', mail)
      await pushNotification(db, { org_id: orgId, project_id: mail.project_id, type: 'info', severity: 'warning', title: 'Terminrelevante E-Mail erkannt', message: `${maler.name} (Malerbetrieb Lang): „${malerTask.name}“ – neuer möglicher Beginn ${fmt(newStart)}. Bitte im Posteingang prüfen.` })
    }
  }

  for (const p of await repo.projects(orgId)) await svc.recomputeAndPersist(orgId, p.id)
  console.log(`[seed] Demo-Organisation angelegt. Login z. B. dino.sejdinovic@baumission.de / ${DEMO_PASSWORD} · Demo-Gewerkeplan: /share/${DEMO_SHARE_TOKEN}`)
}

async function persistPlan(db: Db, projectId: string, plan: PlanState): Promise<void> {
  const statements: BatchStatement[] = [
    { sql: 'DELETE FROM task_dependencies WHERE project_id = ?', params: [projectId] },
    { sql: 'DELETE FROM tasks WHERE project_id = ?', params: [projectId] },
    ...plan.tasks.map((t) => buildInsert('tasks', t)),
    ...plan.dependencies.map((d) => buildInsert('task_dependencies', d)),
  ]
  await db.batch(statements)
}

async function logHistory(db: Db, projectId: string, before: PlanState, after: PlanState, session: Session, reason: string, at: string, source = 'MANUAL'): Promise<void> {
  const byId = new Map(before.tasks.map((t) => [t.id, t]))
  for (const t of after.tasks) {
    const o = byId.get(t.id)
    if (!o) continue
    if (o.start_date !== t.start_date || o.end_date !== t.end_date) {
      await db.insert('change_history', {
        id: newId('ch'), project_id: projectId, task_id: t.id, task_name: t.name, user_id: session.user.id, user_name: session.user.name, created_at: at,
        field: 'Termin', old_value: `${formatDate(o.start_date)}–${formatDate(o.end_date)}`, new_value: `${formatDate(t.start_date)}–${formatDate(t.end_date)}`, reason, source,
      })
    }
    if (o.status !== t.status) {
      await db.insert('change_history', {
        id: newId('ch'), project_id: projectId, task_id: t.id, task_name: t.name, user_id: session.user.id, user_name: session.user.name, created_at: at,
        field: 'Status', old_value: o.status, new_value: t.status, reason, source,
      })
    }
  }
}

/**
 * Spielt den Projektverlauf bis `today` durch: vergangene Vorgänge erledigt (mit
 * Ist-Terminen), laufende mit plausiblem Fortschritt, optional ein verzögerter und ein
 * blockierter Vorgang inkl. Vor-Ort-Meldungen.
 */
async function simulateProgress(
  plan: PlanState,
  ctx: ReturnType<ProjectService['planContext']>,
  today: string,
  special: { delayed?: { match: string; reason: string; days: number; comment: string }; blocked?: { match: string; comment: string } },
  db: Db,
  projectId: string,
  session: Session,
): Promise<PlanState> {
  const todayDay = toDayNumber(today)
  let state = plan
  const sched = recompute(state, ctx).result
  const leaves = state.tasks.filter((t) => sched.tasks.get(t.id)?.isLeaf).sort((a, b) => a.start_date.localeCompare(b.start_date))
  let seed = 7
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
  for (const t of leaves) {
    const s = sched.tasks.get(t.id)!
    if (s.end < todayDay) {
      state = updateTaskFields(state, ctx, t.id, { status: 'done', progress: 100, actual_start: fromDayNumber(s.start), actual_finish: fromDayNumber(s.end) })
      continue
    }
    if (s.start <= todayDay && t.type !== 'milestone') {
      const planned = s.plannedProgress
      const isDelayed = special.delayed && t.name.includes(special.delayed.match)
      const isBlocked = special.blocked && t.name.includes(special.blocked.match)
      if (isDelayed) {
        const before = state
        state = updateTaskFields(state, ctx, t.id, { status: 'delayed', progress: Math.max(0, planned - 30), actual_start: fromDayNumber(s.start) })
        const newEnd = fromDayNumber(s.calendar.addWorkdays(s.end, special.delayed!.days))
        state = updateTaskFields(state, ctx, t.id, { duration: t.duration + special.delayed!.days })
        const at = new Date(Date.parse(today) - 86400000 * 1).toISOString()
        await logHistory(db, projectId, before, state, session, `${special.delayed!.comment}`, at, 'SITE_UPDATE')
        await db.insert('delay_events', { id: newId('dl'), project_id: projectId, task_id: t.id, user_id: session.user.id, created_at: at, reason: special.delayed!.reason, days: special.delayed!.days, comment: special.delayed!.comment })
        await db.insert('progress_updates', { id: newId('pu'), project_id: projectId, task_id: t.id, user_id: session.user.id, created_at: at, flag: 'delayed', progress: Math.max(0, planned - 30), comment: special.delayed!.comment, delay_reason: special.delayed!.reason, new_forecast_end: newEnd, attachments: [] })
        await pushNotification(db, { org_id: session.org.id, project_id: projectId, type: 'site_update', severity: 'critical', title: `Vor-Ort-Update: ${t.name}`, message: `${session.user.name} meldet "Verzögert", +${special.delayed!.days} Arbeitstage – ${special.delayed!.comment}` })
      } else if (isBlocked) {
        state = updateTaskFields(state, ctx, t.id, { status: 'at_risk', progress: Math.max(0, planned - 20), actual_start: fromDayNumber(s.start) })
        const at = new Date(Date.parse(today) - 86400000 * 2).toISOString()
        await db.insert('progress_updates', { id: newId('pu'), project_id: projectId, task_id: t.id, user_id: session.user.id, created_at: at, flag: 'at_risk', progress: Math.max(0, planned - 20), comment: special.blocked!.comment, delay_reason: 'planning', new_forecast_end: null, attachments: [] })
        await pushNotification(db, { org_id: session.org.id, project_id: projectId, type: 'site_update', severity: 'warning', title: `Vor-Ort-Update: ${t.name}`, message: `${session.user.name} meldet "Gefährdet" – ${special.blocked!.comment}` })
      } else {
        const p = Math.max(5, Math.min(95, planned + Math.round((rnd() - 0.4) * 20)))
        state = updateTaskFields(state, ctx, t.id, { status: 'in_progress', progress: p, actual_start: fromDayNumber(s.start) })
        await db.insert('progress_updates', { id: newId('pu'), project_id: projectId, task_id: t.id, user_id: session.user.id, created_at: new Date(Date.parse(today) - 86400000 * Math.round(rnd() * 3)).toISOString(), flag: 'on_track', progress: p, comment: '', delay_reason: null, new_forecast_end: null, attachments: [] })
      }
    }
  }
  return state
}

// ---------------------------------------------------------------------------
// Echter Arbeitsbereich (kein Demo): leere Projektliste, aber Standard-Stammdaten.
// ---------------------------------------------------------------------------

export const WORKSPACE_ORG_ID = 'org_baumission_live'
export const WORKSPACE_PASSWORD = 'Bau2026!'

/** Legt den produktiven Bereich "Baumission" mit Gewerken und Standardkalender an (idempotent). */
export async function seedWorkspaceOrg(db: Db): Promise<void> {
  if (await db.get('SELECT id FROM organizations WHERE id = ?', WORKSPACE_ORG_ID)) return
  console.log('[seed] Arbeitsbereich Baumission wird angelegt …')
  const now = nowISO()
  await db.insert('organizations', { id: WORKSPACE_ORG_ID, name: 'Baumission', slug: 'baumission-live', holiday_region: 'DE-BY', created_at: now })

  const people: { name: string; email: string; role: OrgRole }[] = [
    { name: 'Dino-Denis Sejdinovic (DDS)', email: 'dds@es-wohnbau-sanierung.de', role: 'owner' },
    { name: 'Edis Sejdinovic (ES)', email: 'es@es-wohnbau-sanierung.de', role: 'admin' },
    { name: 'Ammar Sejdinovic (AS)', email: 'ams@es-wohnbau-sanierung.de', role: 'admin' },
    { name: 'Alan Jahic (AJ)', email: 'marketing@baumission.de', role: 'admin' },
  ]
  const pw = await hashPassword(WORKSPACE_PASSWORD)
  for (const p of people) {
    const existing = await db.get<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower(?)', p.email)
    const id = existing?.id ?? newId('usr')
    if (!existing) await db.insert('users', { id, email: p.email, name: p.name, password_hash: pw, created_at: now })
    await db.upsert('organization_members', { org_id: WORKSPACE_ORG_ID, user_id: id, role: p.role }, ['org_id', 'user_id'])
  }

  // Standard-Arbeitskalender Mo–Fr (Feiertage über die Region DE-BY)
  await db.insert('project_calendars', {
    id: newId('cal'), org_id: WORKSPACE_ORG_ID, project_id: null, trade_id: null, company_id: null,
    holiday_region: null, name: 'Standard (Mo–Fr)', working_days: [1, 2, 3, 4, 5], is_default: true,
  })

  // Übliche Gewerke
  for (let i = 0; i < DEFAULT_TRADES.length; i++) {
    const t = DEFAULT_TRADES[i]!
    await db.insert('trades', { id: newId('tr'), org_id: WORKSPACE_ORG_ID, name: t.name, color: t.color, sort_order: i })
  }
}

export const ES_ORG_ID = 'org_es_wohnbau'
export const ES_PASSWORD = 'San!erung26'

/** Eigener Bereich "ES Wohnbau und Sanierung" mit einem einzigen Inhaber (idempotent). */
export async function seedEsWohnbauOrg(db: Db): Promise<void> {
  if (await db.get('SELECT id FROM organizations WHERE id = ?', ES_ORG_ID)) return
  console.log('[seed] Arbeitsbereich ES Wohnbau und Sanierung wird angelegt …')
  const now = nowISO()
  await db.insert('organizations', { id: ES_ORG_ID, name: 'ES Wohnbau und Sanierung', slug: 'es-wohnbau-sanierung', holiday_region: 'DE-BY', created_at: now })

  const email = 'info@es-wohnbau-sanierung.de'
  const existing = await db.get<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower(?)', email)
  const userId = existing?.id ?? newId('usr')
  if (!existing) {
    await db.insert('users', { id: userId, email, name: 'Dino-Denis Sejdinovic', password_hash: await hashPassword(ES_PASSWORD), created_at: now })
  }
  await db.upsert('organization_members', { org_id: ES_ORG_ID, user_id: userId, role: 'owner' }, ['org_id', 'user_id'])

  await db.insert('project_calendars', {
    id: newId('cal'), org_id: ES_ORG_ID, project_id: null, trade_id: null, company_id: null,
    holiday_region: null, name: 'Standard (Mo–Fr)', working_days: [1, 2, 3, 4, 5], is_default: true,
  })

  for (let i = 0; i < DEFAULT_TRADES.length; i++) {
    const t = DEFAULT_TRADES[i]!
    await db.insert('trades', { id: newId('tr'), org_id: ES_ORG_ID, name: t.name, color: t.color, sort_order: i })
  }
}
