/**
 * Regelbasierter E-Mail-Analyzer (deterministisch, keine KI): Absender → Firma/Kontakt,
 * Projekt-Kandidaten, Datumsangaben, Schlüsselwort-Klassifikation, Vorgangszuordnung,
 * daraus Change-Proposal-Operationen. Ehrlich begrenzt: erkennt typische Formulierungen
 * („können erst am 18.06. beginnen“), keine freie Sprachinterpretation - dafür ist der
 * KI-Analyzer mit demselben Vertrag vorgesehen.
 */

import type { ISODate, ProposalOperation } from '../../types.ts'
import { addDays, toDayNumber } from '../../engine/dates.ts'
import type { EmailAnalysis, EmailAnalysisContext, EmailAnalyzer, EmailMessageType, InboundEmailMessage } from './types.ts'

const MONTHS: Record<string, number> = { januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12, jan: 1, feb: 2, mär: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, okt: 10, nov: 11, dez: 12 }

/** Findet Datumsangaben (dd.mm.yyyy, dd.mm.yy, dd.mm., „18. Juni“) in Textreihenfolge. */
export function extractDates(text: string, today: ISODate): ISODate[] {
  const out: { pos: number; date: ISODate }[] = []
  const todayY = Number(today.slice(0, 4))
  const todayM = Number(today.slice(5, 7))
  const inferYear = (m: number): number => (m < todayM - 2 ? todayY + 1 : todayY)
  const push = (pos: number, d: number, m: number, y: number | null) => {
    if (d < 1 || d > 31 || m < 1 || m > 12) return
    const year = y === null ? inferYear(m) : y < 100 ? 2000 + y : y
    const iso = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    if (isNaN(toDayNumber(iso))) return
    out.push({ pos, date: iso })
  }
  const re1 = /\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?!\d)/g
  let m: RegExpExecArray | null
  while ((m = re1.exec(text))) push(m.index, Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null)
  const re2 = /\b(\d{1,2})\.\s*(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|jan|feb|mär|apr|jun|jul|aug|sep|sept|okt|nov|dez)\.?(?:\s+(\d{4}))?/gi
  while ((m = re2.exec(text))) push(m.index, Number(m[1]), MONTHS[m[2].toLowerCase()], m[3] ? Number(m[3]) : null)
  out.sort((a, b) => a.pos - b.pos)
  const seen = new Set<string>()
  return out.filter((x) => (seen.has(x.date) ? false : (seen.add(x.date), true))).map((x) => x.date)
}

const KEYWORDS: { type: EmailMessageType; re: RegExp; weight: number }[] = [
  { type: 'SCHEDULE_CHANGE', re: /nicht wie (geplant|besprochen|vereinbart)|schaffen (es|wir) (leider )?nicht|verschieb|k[öo]nnen (leider )?erst|erst (ab|am) |sp[äa]ter (anfangen|beginnen|starten)|neuer termin|verz[öo]ger|nicht (am|wie) .{0,40}(beginnen|anfangen|starten)/i, weight: 3 },
  { type: 'MATERIAL_DELAY', re: /material|fliesen kommen|fenster kommen|(kommt|kommen) erst|liefer(ung|termin|verz)|geliefert|wird erst .{0,20}geliefert/i, weight: 2 },
  { type: 'DELIVERY_CHANGE', re: /anlieferung|liefertermin|lieferung (ist|wurde|wird)/i, weight: 2 },
  { type: 'RESOURCE_PROBLEM', re: /kolonne|mitarbeiter|personal|krank|komplett belegt|ausgebucht|kapazit|keine leute|unterbesetzt/i, weight: 3 },
  { type: 'MISSING_PRECONDITION', re: /brauchen (vorher|zuerst|davor)|vorleistung|voraussetzung|bevor wir|erst wenn|fertige (abdichtung|estrich|untergrund)|muss vorher/i, weight: 3 },
  { type: 'APPROVAL_DELAY', re: /freigabe|genehmigung|fehlt noch|noch nicht freigegeben|warten auf .{0,20}(bauherr|kunde|freigabe)/i, weight: 3 },
  { type: 'SCHEDULE_CONFIRMATION', re: /best[äa]tig|passt (uns|so)|wie besprochen (kommen|sind|starten)|k[öo]nnen wie geplant|in ordnung|termin (steht|passt)/i, weight: 3 },
  { type: 'SCHEDULE_OPTIMIZATION', re: /fr[üu]her (anfangen|beginnen|starten|fertig)|schon (am )?(montag|dienstag|mittwoch|donnerstag|freitag)|zus[äa]tzliche(n|r)? (leute|kolonne|mitarbeiter)|vorziehen|eher anfangen/i, weight: 3 },
]

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-zäöüß0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 4)
}

export class RuleBasedEmailAnalyzer implements EmailAnalyzer {
  readonly kind = 'rules' as const

  async analyze(msg: InboundEmailMessage, ctx: EmailAnalysisContext): Promise<EmailAnalysis> {
    return this.analyzeSync(msg, ctx)
  }

  /** Synchron (deterministisch, ohne I/O) - für Seed und Tests */
  analyzeSync(msg: InboundEmailMessage, ctx: EmailAnalysisContext): EmailAnalysis {
    const text = `${msg.subject}\n${msg.body_text}`
    const lower = text.toLowerCase()
    const fromEmail = msg.from_email.trim().toLowerCase()
    const domain = fromEmail.split('@')[1] ?? ''

    // ---- Absender
    const contact = ctx.contacts.find((c) => c.email && c.email.toLowerCase() === fromEmail) ?? null
    let company = contact ? (ctx.companies.find((c) => c.id === contact.company_id) ?? null) : (ctx.companies.find((c) => c.email && c.email.toLowerCase() === fromEmail) ?? null)
    if (!company && domain && !GENERIC_DOMAINS.has(domain)) {
      company = ctx.companies.find((c) => c.email && c.email.toLowerCase().split('@')[1] === domain) ?? ctx.contacts.filter((c) => c.email.toLowerCase().split('@')[1] === domain).map((c) => ctx.companies.find((x) => x.id === c.company_id) ?? null).find((x) => !!x) ?? null
    }

    // ---- Projekt-Kandidaten
    const scores = new Map<string, { score: number; why: string[] }>()
    const add = (pid: string, s: number, why: string) => {
      const e = scores.get(pid) ?? { score: 0, why: [] }
      e.score += s
      e.why.push(why)
      scores.set(pid, e)
    }
    if (contact) for (const pid of contact.project_ids) add(pid, 3, 'Kontakt ist dem Projekt zugeordnet')
    if (company) {
      for (const pid of new Set(ctx.tasks.filter((t) => t.company_id === company!.id && t.status !== 'done').map((t) => t.project_id))) add(pid, 2, 'Firma ist im Projekt eingeplant')
      for (const s of ctx.shareLinks) if (s.company_id === company.id) add(s.project_id, 1, 'Gewerkeplan-Link für die Firma')
    }
    for (const p of ctx.projects) {
      if (p.state === 'completed') continue
      if (p.number && lower.includes(p.number.toLowerCase())) add(p.id, 3, `Projektnummer ${p.number} genannt`)
      const nameTokens = tokens(p.name).filter((t) => !STOP.has(t))
      const hit = nameTokens.filter((t) => lower.includes(t))
      if (hit.length && hit.length >= Math.ceil(nameTokens.length / 2)) add(p.id, 2, `Projektname „${p.name}“ genannt`)
      const addr = tokens(p.address).filter((t) => !STOP.has(t) && !/^\d+$/.test(t))
      if (addr.length && addr.every((t) => lower.includes(t))) add(p.id, 2, `Adresse ${p.address} genannt`)
      if (p.customer && lower.includes(p.customer.toLowerCase())) add(p.id, 1, `Bauherr ${p.customer} genannt`)
    }
    const projectCandidates = [...scores.entries()].map(([project_id, e]) => ({ project_id, project_name: ctx.projects.find((p) => p.id === project_id)?.name ?? project_id, score: e.score, why: e.why.join(', ') })).sort((a, b) => b.score - a.score).slice(0, 3)

    // ---- Klassifikation
    const typeScores = new Map<EmailMessageType, number>()
    for (const k of KEYWORDS) if (k.re.test(text)) typeScores.set(k.type, (typeScores.get(k.type) ?? 0) + k.weight)
    const dates = extractDates(text, ctx.today)
    if (dates.length >= 2 && (typeScores.get('SCHEDULE_CHANGE') ?? 0) > 0) typeScores.set('SCHEDULE_CHANGE', (typeScores.get('SCHEDULE_CHANGE') ?? 0) + 2)
    if ((typeScores.get('MATERIAL_DELAY') ?? 0) > 0 && (typeScores.get('SCHEDULE_CHANGE') ?? 0) > 0 && /material|fliesen|fenster|liefer/i.test(text)) typeScores.set('MATERIAL_DELAY', (typeScores.get('MATERIAL_DELAY') ?? 0) + 2)
    if ((typeScores.get('SCHEDULE_CONFIRMATION') ?? 0) > 0 && (typeScores.get('SCHEDULE_CHANGE') ?? 0) > 0) typeScores.set('SCHEDULE_CONFIRMATION', 0) // „nicht wie besprochen“ ist keine Bestätigung
    let messageType: EmailMessageType = 'GENERAL_INFORMATION'
    let best = 0
    for (const [t, s] of typeScores) if (s > best) { best = s; messageType = t }
    const hints: EmailAnalysis['hints'] = []
    for (const [t, s] of typeScores) if (s > 0 && t !== messageType) hints.push({ kind: t, text: HINT_TEXT[t] })

    // ---- Vorgangs-Kandidaten
    const projIds = projectCandidates.length ? projectCandidates.map((p) => p.project_id) : ctx.projects.filter((p) => p.state !== 'completed').map((p) => p.id)
    const bodyTokens = new Set(tokens(text))
    const taskCandidates: EmailAnalysis['task_candidates'] = []
    for (const t of ctx.tasks) {
      if (!projIds.includes(t.project_id) || t.status === 'done') continue
      let s = 0
      const why: string[] = []
      if (company && t.company_id === company.id) { s += 3; why.push('Firma zugeordnet') }
      else if (company && t.trade_id && company.trade_ids.includes(t.trade_id)) { s += 2; why.push('Gewerk der Firma') }
      const nt = tokens(t.name).filter((x) => !STOP.has(x))
      const nameHits = nt.filter((x) => bodyTokens.has(x) || [...bodyTokens].some((b) => b.startsWith(x.slice(0, 5)) && x.length >= 5))
      if (nameHits.length) { s += Math.min(3, nameHits.length * 1.5); why.push(`Bezeichnung „${t.name}“ passt`) }
      if (dates.length) {
        const near = Math.min(...dates.map((d) => Math.abs(toDayNumber(d) - toDayNumber(t.start_date))))
        if (near === 0) { s += 3; why.push('Datum = geplanter Start') }
        else if (near <= 3) { s += 2; why.push('Datum nahe am geplanten Start') }
        else if (near <= 14) { s += 0.5 }
      }
      const pi = projectCandidates.findIndex((p) => p.project_id === t.project_id)
      if (pi === 0) s += 1
      if (s >= 2) taskCandidates.push({ task_id: t.id, task_name: t.name, project_id: t.project_id, score: s, why: why.join(', ') })
    }
    taskCandidates.sort((a, b) => b.score - a.score)
    const top = taskCandidates.slice(0, 3)
    const task = top[0] ?? null

    // ---- Alt/Neu-Datum
    let oldDate: ISODate | null = null
    let newDate: ISODate | null = null
    if (dates.length >= 2) {
      const sorted = [...dates].sort()
      oldDate = sorted[0]
      newDate = sorted[sorted.length - 1]
      if (task) {
        const t = ctx.tasks.find((x) => x.id === task.task_id)!
        const exact = dates.find((d) => d === t.start_date)
        if (exact) { oldDate = exact; newDate = dates.find((d) => d !== exact) ?? newDate }
      }
    } else if (dates.length === 1) {
      newDate = dates[0]
      if (task) oldDate = ctx.tasks.find((x) => x.id === task.task_id)!.start_date
    }
    const textDelta = /(\+|um |etwa |ca\.? )?(\d{1,2})\s*(arbeits)?tage?\s*(sp[äa]ter|verz[öo]ger)/i.exec(text)
    let deltaDays: number | null = oldDate && newDate ? toDayNumber(newDate) - toDayNumber(oldDate) : null
    if (deltaDays === null && textDelta && task) {
      deltaDays = Number(textDelta[2])
      oldDate = ctx.tasks.find((x) => x.id === task.task_id)!.start_date
      newDate = addDays(oldDate, deltaDays)
    }

    // ---- Operationen (nur Vorschlag)
    const operations: ProposalOperation[] = []
    const scheduleTypes: EmailMessageType[] = ['SCHEDULE_CHANGE', 'MATERIAL_DELAY', 'DELIVERY_CHANGE']
    if (task && newDate && scheduleTypes.includes(messageType) && (deltaDays ?? 1) > 0) {
      operations.push({ op: 'move_task', task_id: task.task_id, new_start: newDate, cascade: true })
    }
    if (task && messageType === 'MATERIAL_DELAY') operations.push({ op: 'add_constraint', task_id: task.task_id, type: 'material', title: `Materiallieferung laut E-Mail${newDate ? ` (${fmt(newDate)})` : ''}`, due_date: newDate })
    if (task && messageType === 'DELIVERY_CHANGE' && !operations.some((o) => o.op === 'add_constraint')) operations.push({ op: 'add_constraint', task_id: task.task_id, type: 'material', title: `Lieferung laut E-Mail${newDate ? ` (${fmt(newDate)})` : ''}`, due_date: newDate })
    if (task && messageType === 'MISSING_PRECONDITION') operations.push({ op: 'add_constraint', task_id: task.task_id, type: 'predecessor', title: `Vorleistung laut E-Mail: ${firstSentence(msg.body_text)}`, due_date: null })
    if (task && messageType === 'APPROVAL_DELAY') operations.push({ op: 'add_constraint', task_id: task.task_id, type: 'approval', title: `Freigabe fehlt laut E-Mail: ${firstSentence(msg.body_text)}`, due_date: null })
    if (task && messageType === 'SCHEDULE_OPTIMIZATION' && newDate && (deltaDays ?? 0) < 0) operations.push({ op: 'move_task', task_id: task.task_id, new_start: newDate, cascade: true })

    // ---- Konfidenz (ehrlich: Heuristik)
    let confidence = 0.2
    if (company) confidence += 0.2
    if (projectCandidates[0]) confidence += Math.min(0.2, projectCandidates[0].score * 0.05)
    if (task) confidence += Math.min(0.2, task.score * 0.04)
    if (best >= 3) confidence += 0.1
    if (newDate) confidence += 0.1
    confidence = Math.min(0.9, Math.round(confidence * 100) / 100)

    const reasonParts: string[] = []
    reasonParts.push(company ? `Absender ${company.name}` : 'Absender unbekannt')
    if (projectCandidates[0]) reasonParts.push(`Projekt ${projectCandidates[0].project_name} (${projectCandidates[0].why})`)
    if (task) reasonParts.push(`Vorgang „${task.task_name}“ (${task.why})`)
    if (best > 0) reasonParts.push(`Schlüsselwörter → ${messageType}`)
    if (dates.length) reasonParts.push(`Datumsangaben: ${dates.map(fmt).join(', ')}`)

    return {
      analyzer: 'rules', message_type: messageType, confidence, reason: reasonParts.join(' · '),
      sender: { email: msg.from_email, name: msg.from_name }, company_id: company?.id ?? null, company_name: company?.name ?? null, contact_id: contact?.id ?? null,
      project_candidates: projectCandidates, task_candidates: top, old_date: oldDate, new_date: newDate, dates, delta_days: deltaDays, operations, hints, original_message_id: msg.id,
    }
  }
}

const GENERIC_DOMAINS = new Set(['gmail.com', 'web.de', 'gmx.de', 'gmx.net', 't-online.de', 'outlook.com', 'hotmail.com', 'yahoo.de', 'icloud.com', 'example.com'])
const STOP = new Set(['haus', 'projekt', 'neubau', 'sanierung', 'straße', 'strasse', 'wohnung', 'firma', 'gmbh', 'arbeiten', 'montage'])
const HINT_TEXT: Record<EmailMessageType, string> = {
  SCHEDULE_CHANGE: 'Terminverschiebung angesprochen',
  MATERIAL_DELAY: 'Material/Lieferung betroffen → Voraussetzung „Material“ prüfen',
  RESOURCE_PROBLEM: 'Kapazität/Kolonne angesprochen → Ressourcenzuweisung prüfen',
  MISSING_PRECONDITION: 'Vorleistung gefordert → möglicherweise fehlende Abhängigkeit',
  APPROVAL_DELAY: 'Freigabe fehlt → Voraussetzung „Freigabe“ prüfen',
  DELIVERY_CHANGE: 'Liefertermin geändert',
  SCHEDULE_CONFIRMATION: 'Termin bestätigt',
  SCHEDULE_OPTIMIZATION: 'Früherer Beginn möglich → Terminoptimierung prüfen',
  GENERAL_INFORMATION: 'Allgemeine Information',
}

function firstSentence(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  const m = /^(.{10,140}?[.!?])(\s|$)/.exec(t)
  return (m ? m[1] : t.slice(0, 120)).trim()
}
function fmt(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`
}
