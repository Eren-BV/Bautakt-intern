/**
 * Rule/Constraint Engine - fachliche Regeln als Grenzen. Getrennt von der Scheduling
 * Engine (die rechnet Termine) und von der KI (die später nur INNERHALB dieser Regeln
 * Varianten suchen darf). Regeln sind systemweit (org_id null), je Organisation, je
 * Projekt oder je Vorlage definierbar; die Auswertung ist deterministisch.
 *
 * Regelarten:
 *   required_order  Kategorie B darf im selben Abschnitt nicht vor Abschluss von Kategorie A beginnen
 *   min_gap         zwischen Ende Kategorie A und Start Kategorie B (oder jedem Nachfolger) müssen
 *                   mindestens N Kalendertage liegen (z. B. Trocknung, Aushärtung, Freigabe)
 *   no_overlap      Kategorie A und Kategorie B dürfen im selben Abschnitt nicht parallel laufen
 *
 * Kategorien werden über Namen verglichen (systemweite Regeln kennen keine Org-IDs); optional
 * über Vorgangsnamen-Muster, wenn eine Kategorie nicht zugeordnet ist.
 */

import type { ISODate, ProjectSection, Task, TaskDependency, Trade } from '../types.ts'
import type { ScheduleResult } from '../engine/schedule.ts'
import { formatDate, fromDayNumber } from '../engine/dates.ts'

export type RuleKind = 'required_order' | 'min_gap' | 'no_overlap'
export type RuleScope = 'system' | 'org' | 'project' | 'template'
export type RuleSeverity = 'info' | 'warning' | 'critical'

export interface RuleConfig {
  /** Gewerk A (Vorleistung) - Name, Vergleich ohne Groß/Klein */
  trade_a: string
  /** Gewerk B (Folgeleistung); leer bei min_gap = jeder Nachfolger von A */
  trade_b: string | null
  /** min_gap: Kalendertage zwischen Ende A und Start B */
  min_days?: number
  /** optionale Vorgangsnamen-Muster (Regex, i) als Ersatz für fehlende Gewerkzuordnung */
  pattern_a?: string
  pattern_b?: string
  /** Namensmuster muss zusätzlich zum Gewerk passen (z. B. nur Betonagen im Rohbau) */
  pattern_required?: boolean
  /** nur innerhalb desselben Bauabschnitts prüfen (Standard true) */
  same_section?: boolean
}

export interface PlanRule {
  id: string
  org_id: string | null
  project_id: string | null
  template_id: string | null
  kind: RuleKind
  name: string
  config: RuleConfig
  severity: RuleSeverity
  enabled: boolean
  created_at: string
}

export interface RuleViolation {
  rule_id: string
  rule_name: string
  kind: RuleKind
  severity: RuleSeverity
  task_id: string
  related_task_id: string
  message: string
  recommendation: string
}

export const RULE_KIND_LABELS: Record<RuleKind, string> = {
  required_order: 'Reihenfolge (B erst nach A)',
  min_gap: 'Mindestabstand / Wartezeit',
  no_overlap: 'Keine Überlappung',
}

export function scopeOf(rule: Pick<PlanRule, 'org_id' | 'project_id' | 'template_id'>): RuleScope {
  if (rule.project_id) return 'project'
  if (rule.template_id) return 'template'
  if (rule.org_id) return 'org'
  return 'system'
}

/** Systemweite Grundregeln (Hochbau) - Grenzen, die auch eine KI nicht überschreiben darf. */
export const SYSTEM_RULES: PlanRule[] = [
  rule('sys_estrich_fliesen', 'min_gap', 'Fliesen nicht vor Untergrundreife des Estrichs', { trade_a: 'Estrich', trade_b: 'Fliesen', min_days: 21, pattern_a: 'estrich', pattern_b: 'fliesen' }, 'critical'),
  rule('sys_estrich_boden', 'min_gap', 'Bodenbeläge erst nach Belegreife des Estrichs', { trade_a: 'Estrich', trade_b: 'Bodenleger', min_days: 28, pattern_a: 'estrich', pattern_b: 'parkett|bodenbelag|vinyl|laminat|teppich' }, 'critical'),
  rule('sys_putz_estrich', 'required_order', 'Estrich erst nach Innenputz', { trade_a: 'Innenputz', trade_b: 'Estrich', pattern_a: 'innenputz', pattern_b: 'estrich' }, 'warning'),
  rule('sys_putz_trocknung', 'min_gap', 'Innenputz braucht Trocknungszeit vor Estrich', { trade_a: 'Innenputz', trade_b: 'Estrich', min_days: 7, pattern_a: 'innenputz', pattern_b: 'estrich' }, 'warning'),
  rule('sys_beton_decke', 'min_gap', 'Betonage: Ausschalen/Belasten nicht vor Aushärtung', { trade_a: 'Rohbau', trade_b: null, min_days: 5, pattern_a: 'beton(age|ieren)|decke betonieren|bodenplatte betonieren', pattern_required: true }, 'critical'),
  rule('sys_rohinstall_putz', 'required_order', 'Innenputz erst nach Rohinstallation Elektro', { trade_a: 'Elektro', trade_b: 'Innenputz', pattern_a: 'rohinstallation|leerrohr|schlitze', pattern_b: 'innenputz', pattern_required: true }, 'warning'),
  rule('sys_shk_roh_putz', 'required_order', 'Innenputz erst nach Rohinstallation SHK', { trade_a: 'SHK', trade_b: 'Innenputz', pattern_a: 'rohinstallation|rohmontage', pattern_b: 'innenputz', pattern_required: true }, 'warning'),
  rule('sys_fenster_putz', 'required_order', 'Innenputz erst nach Fenstereinbau (Gebäude dicht)', { trade_a: 'Fenster', trade_b: 'Innenputz', pattern_a: 'fenster', pattern_b: 'innenputz' }, 'warning'),
  rule('sys_dach_ausbau', 'required_order', 'Innenausbau erst nach Dacheindeckung', { trade_a: 'Dachdecker', trade_b: 'Trockenbau', pattern_a: 'eindeckung|dach decken|dachdeck', pattern_b: 'trockenbau' }, 'warning'),
  rule('sys_maler_boden', 'no_overlap', 'Maler- und Bodenlegerarbeiten nicht gleichzeitig im selben Abschnitt', { trade_a: 'Maler', trade_b: 'Bodenleger', pattern_a: 'maler|anstrich|tapez', pattern_b: 'parkett|bodenbelag|vinyl|laminat' }, 'info'),
  rule('sys_shk_fertig', 'required_order', 'SHK-Fertigmontage erst nach Fliesenarbeiten', { trade_a: 'Fliesen', trade_b: 'SHK', pattern_a: 'fliesen', pattern_b: 'fertigmontage|endmontage|sanitärobjekte', pattern_required: true }, 'warning'),
]

function rule(id: string, kind: RuleKind, name: string, config: RuleConfig, severity: RuleSeverity): PlanRule {
  return { id, org_id: null, project_id: null, template_id: null, kind, name, config: { same_section: true, ...config }, severity, enabled: true, created_at: '2026-09-18T00:00:00.000Z' }
}

export interface RuleContext {
  tasks: Task[]
  dependencies: TaskDependency[]
  sched: ScheduleResult
  trades: Trade[]
  sections?: ProjectSection[]
}

/** Wertet alle aktiven Regeln gegen den berechneten Plan aus. */
export function evaluateRules(rules: PlanRule[], ctx: RuleContext): RuleViolation[] {
  const out: RuleViolation[] = []
  const tradeName = new Map(ctx.trades.map((t) => [t.id, t.name.toLowerCase()]))
  const leaves = ctx.tasks.filter((t) => ctx.sched.tasks.get(t.id)?.isLeaf && t.type !== 'milestone')
  // Gewerk zugeordnet → Gewerk entscheidet; ohne Gewerk → Namensmuster. Mit pattern_required
  // muss zusätzlich der Name passen (z. B. nur Betonagen innerhalb des Rohbaus).
  // Warte-/Trocknungsvorgänge sind selbst die geforderte Wartezeit - sie zählen nicht als Vorleistung/Folgeleistung
  const WAIT = /trocknung|trocknen|aush[äa]rt|abbinde|wartezeit|reifezeit|belegreife/i
  const matches = (t: Task, trade: string | null, pattern?: string, patternRequired?: boolean): boolean => {
    if (WAIT.test(t.name)) return false
    const tn = t.trade_id ? tradeName.get(t.trade_id) : undefined
    const byPattern = pattern ? new RegExp(pattern, 'i').test(t.name) : false
    if (trade && tn) return tn === trade.toLowerCase() && (!patternRequired || byPattern)
    return byPattern
  }
  const seen = new Set<string>()
  for (const r of rules) {
    if (!r.enabled) continue
    const c = r.config
    const sameSection = c.same_section !== false
    const as = leaves.filter((t) => matches(t, c.trade_a, c.pattern_a, c.pattern_required))
    const bs = c.trade_b || c.pattern_b ? leaves.filter((t) => matches(t, c.trade_b, c.pattern_b, c.pattern_required)) : []
    for (const a of as) {
      const sa = ctx.sched.tasks.get(a.id)!
      const candidates = c.trade_b || c.pattern_b ? bs : successorsOf(a, ctx)
      for (const b of candidates) {
        if (a.id === b.id) continue
        if (sameSection && a.section_id && b.section_id && a.section_id !== b.section_id) continue
        const sb = ctx.sched.tasks.get(b.id)!
        const key = `${r.id}|${a.id}|${b.id}`
        if (seen.has(key)) continue
        let violation: { message: string; recommendation: string } | null = null
        if (r.kind === 'required_order') {
          // B beginnt vor Ende A - nur werten, wenn A und B im selben Ablauf liegen (A endet nicht komplett nach B)
          if (sb.start <= sa.end && !(sa.start > sb.end)) {
            violation = { message: `„${b.name}“ beginnt am ${d(sb.start)}, bevor „${a.name}“ am ${d(sa.end)} abgeschlossen ist.`, recommendation: `Abhängigkeit ${a.name} → ${b.name} (Ende–Start) ergänzen oder Termine anpassen.` }
          }
        } else if (r.kind === 'min_gap') {
          const gap = sb.start - sa.end - 1
          if (sb.start > sa.start && gap < (c.min_days ?? 0) && sb.start >= sa.start) {
            violation = { message: `Zwischen „${a.name}“ (Ende ${d(sa.end)}) und „${b.name}“ (Start ${d(sb.start)}) liegen ${Math.max(0, gap)} Tage, gefordert sind ${c.min_days}.`, recommendation: `Lag auf mindestens ${c.min_days} Kalendertage erhöhen oder Wartezeit als Vorgang einfügen.` }
          }
        } else if (r.kind === 'no_overlap') {
          if (sb.start <= sa.end && sa.start <= sb.end) {
            violation = { message: `„${a.name}“ und „${b.name}“ überlappen sich (${d(Math.max(sa.start, sb.start))} – ${d(Math.min(sa.end, sb.end))}).`, recommendation: 'Vorgänge nacheinander planen oder in getrennten Bauabschnitten ausführen.' }
          }
        }
        if (violation) {
          seen.add(key)
          out.push({ rule_id: r.id, rule_name: r.name, kind: r.kind, severity: r.severity, task_id: b.id, related_task_id: a.id, ...violation })
        }
      }
    }
  }
  return out.sort((x, y) => rank(y.severity) - rank(x.severity))
}

function successorsOf(a: Task, ctx: RuleContext): Task[] {
  // Direkte Nachfolger über Abhängigkeiten (inkl. Nachfolger des Elternknotens)
  const ids = new Set<string>()
  let p: string | null = a.id
  const parentOf = new Map(ctx.tasks.map((t) => [t.id, t.parent_id]))
  while (p) {
    for (const d of ctx.dependencies) if (d.predecessor_id === p) ids.add(d.successor_id)
    p = parentOf.get(p) ?? null
  }
  const out: Task[] = []
  for (const id of ids) {
    const t = ctx.tasks.find((x) => x.id === id)
    if (!t) continue
    if (ctx.sched.tasks.get(t.id)?.isLeaf) { if (t.type !== 'milestone') out.push(t) }
    else for (const c of ctx.tasks) if (c.parent_id === t.id && ctx.sched.tasks.get(c.id)?.isLeaf && c.type !== 'milestone') out.push(c)
  }
  return out
}

/**
 * Regeln zusammenführen: System + Org + Projekt (+ Vorlage); deaktivierte Org/Projekt-Kopien
 * überschreiben System-Regeln gleicher ID-Basis.
 * `includeSystem`: die mitgelieferten Systemregeln sind Baustellenphysik (Trocknungszeiten,
 * Gewerkefolgen) - bei nicht-baulichen Projekten (Coaching, Software, interne Vorhaben …)
 * gehören sie nicht dazu. Default true, damit bestehende Aufrufe ohne Projektbezug (z. B. die
 * Regelverwaltung) weiterhin alle Systemregeln zum Bearbeiten sehen.
 */
export function effectiveRules(custom: PlanRule[], projectId: string | null, templateId: string | null = null, includeSystem = true): PlanRule[] {
  const overrides = new Map<string, PlanRule>()
  for (const r of custom) {
    if (r.project_id && r.project_id !== projectId) continue
    if (r.template_id && r.template_id !== templateId) continue
    overrides.set(r.id, r)
  }
  const sys = includeSystem
    ? SYSTEM_RULES.map((r) => {
        // Org-/Projektregel mit id "<sys_id>@<scope-id>" deaktiviert/ersetzt die Systemregel
        const ov = [...overrides.values()].find((o) => o.id.startsWith(r.id + '@'))
        return ov ? { ...r, ...ov, id: r.id, config: { ...r.config, ...ov.config } } : r
      })
    : []
  const own = [...overrides.values()].filter((o) => !SYSTEM_RULES.some((s) => o.id.startsWith(s.id + '@')))
  return [...sys, ...own]
}

const d = (day: number): string => formatDate(fromDayNumber(day) as ISODate)
function rank(s: RuleSeverity) {
  return s === 'critical' ? 2 : s === 'warning' ? 1 : 0
}
