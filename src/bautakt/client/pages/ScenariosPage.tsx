/**
 * Was-wäre-wenn: Szenario = Kopie des Plans. Wird im Gantt bearbeitet (Szenario-Modus),
 * hier verglichen (Projektende, geänderte Vorgänge/Abhängigkeiten, Regelverstöße) und
 * optional übernommen. Szenarien sind auch der sichere Arbeitsraum für Vorschläge
 * („Bearbeiten“) und für die spätere KI-Lösungssuche - der Masterplan bleibt unberührt.
 */

import { useEffect, useMemo, useState } from 'react'
import { FlaskConical, Play, Trash2, Check, ArrowRight, Sparkles, AlertTriangle, Mail } from 'lucide-react'
import { useOrg } from '../store/org'
import { effectiveRules, evaluateRules, type PlanRule } from '../../shared/rules/engine'
import { useProject } from '../store/project'
import { useToast } from '../store/toast'
import { api } from '../lib/api'
import { navigate } from '../lib/router'
import { ProjectHeader } from '../components/ProjectHeader'
import { Badge, Button, Card, Delta, EmptyState, Field, Input, Modal, Spinner, Textarea } from '../components/ui'
import type { Scenario } from '../../shared/types'
import { formatDate, formatDateTime, fromDayNumber } from '../../shared/engine/dates'
import { recompute } from '../../shared/engine/operations'

export function ScenariosPage() {
  const p = useProject()
  const org = useOrg()
  const toast = useToast()
  const [list, setList] = useState<Scenario[] | null>(null)
  const [rules, setRules] = useState<PlanRule[]>([])
  const [solutionInfo, setSolutionInfo] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const load = () => api.projects.scenarios(p.projectId).then(setList).catch((e) => toast.push(e.message, 'error'))
  useEffect(() => {
    void load()
    api.rules.list(p.projectId).then((r) => setRules(effectiveRules(r.custom, p.projectId, null, p.bundle?.project.planning_kind === 'construction'))).catch(() => setRules([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.projectId, p.bundle?.project.planning_kind])

  interface Cmp { end: string; shift: number; changed: number; changedDeps: number; added: number; removed: number; violations: number; newViolations: string[]; resources: string[] }
  const compare = useMemo(() => {
    if (!list || !p.bundle) return new Map<string, Cmp>()
    const base = recompute({ tasks: p.bundle.tasks, dependencies: p.bundle.dependencies }, p.ctx)
    const baseV = evaluateRules(rules, { tasks: base.state.tasks, dependencies: base.state.dependencies, sched: base.result, trades: org.trades })
    const baseKeys = new Set(baseV.map((v) => `${v.rule_id}|${v.task_id}|${v.related_task_id}`))
    const out = new Map<string, Cmp>()
    for (const sc of list) {
      const r = recompute({ tasks: sc.tasks, dependencies: sc.dependencies }, p.ctx)
      const byId = new Map(base.state.tasks.map((t) => [t.id, t]))
      const scIds = new Set(sc.tasks.map((t) => t.id))
      const changed = r.state.tasks.filter((t) => { const o = byId.get(t.id); return o && (o.start_date !== t.start_date || o.end_date !== t.end_date || o.duration !== t.duration) }).length
      const added = r.state.tasks.filter((t) => !byId.has(t.id)).length
      const removed = base.state.tasks.filter((t) => !scIds.has(t.id)).length
      const depKey = (d: { predecessor_id: string; successor_id: string; type: string; lag_days: number }) => `${d.predecessor_id}>${d.successor_id}:${d.type}${d.lag_days}`
      const baseDeps = new Set(base.state.dependencies.map(depKey))
      const scDeps = new Set(sc.dependencies.map(depKey))
      const changedDeps = [...scDeps].filter((k) => !baseDeps.has(k)).length + [...baseDeps].filter((k) => !scDeps.has(k)).length
      const v = evaluateRules(rules, { tasks: r.state.tasks, dependencies: r.state.dependencies, sched: r.result, trades: org.trades })
      const newV = v.filter((x) => !baseKeys.has(`${x.rule_id}|${x.task_id}|${x.related_task_id}`))
      const baseRes = new Set(base.state.tasks.map((t) => t.resource_id).filter(Boolean))
      const resources = [...new Set(r.state.tasks.map((t) => t.resource_id).filter((x): x is string => !!x && !baseRes.has(x)))].map((id) => org.resourceName(id))
      out.set(sc.id, { end: fromDayNumber(r.result.projectEnd), shift: r.result.projectEnd - base.result.projectEnd, changed, changedDeps, added, removed, violations: v.length, newViolations: newV.map((x) => `${x.rule_name}: ${x.message}`), resources })
    }
    return out
  }, [list, p.bundle, p.ctx, rules, org])

  const findSolution = async () => {
    try {
      await api.projects.findSolution(p.projectId, { goal: 'hold_end_date', allow: { resequence: true, parallelize: true, add_resources: false, resequence_sections: true }, disturbance: [] })
    } catch (e) {
      setSolutionInfo((e as Error).message)
    }
  }

  if (!p.bundle || !list) return <Spinner />
  const baseEnd = p.analysis?.planned_end

  const create = async () => {
    try {
      const sc = await api.projects.createScenario(p.projectId, { name: name || 'Szenario', description })
      setDialog(false)
      setName('')
      setDescription('')
      await load()
      p.enterScenario(sc)
      navigate(`/projects/${p.projectId}/gantt`)
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const apply = async (sc: Scenario) => {
    if (!confirm(`Szenario „${sc.name}“ als echten Plan übernehmen? Der aktuelle Plan wird ersetzt (mit Historie).`)) return
    try {
      await api.projects.applyScenario(p.projectId, sc.id)
      toast.push('Szenario übernommen.', 'success')
      p.exitScenario()
      await load()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }

  return (
    <div>
      <ProjectHeader title="Szenarien" actions={p.canEdit && <Button variant="primary" onClick={() => setDialog(true)}><FlaskConical size={15} /> Szenario erstellen</Button>} />
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <p className="text-sm text-ink-soft">Ein Szenario ist eine Kopie des Terminplans. Verschieben Sie darin Vorgänge, ändern Sie Dauern oder Abhängigkeiten – der echte Plan bleibt unberührt. Der Vergleich zeigt Projektende, geänderte Vorgänge und Abhängigkeiten, zusätzliche Ressourcen und neue Regelverstöße; danach übernehmen oder verwerfen.</p>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-soft">
          <Sparkles size={14} className="text-ink-faint" />
          <span><b>✨ Lösung finden</b> – die KI erhält eine Kopie des Plans, sucht innerhalb der fachlichen Regeln nach Varianten (umordnen, parallelisieren, zusätzliches Team, Abschnitte anders sequenzieren) und legt jede Variante als Szenario an.</span>
          <Button size="sm" variant="ghost" onClick={findSolution}>Status prüfen</Button>
          {solutionInfo && <span className="w-full text-warn">{solutionInfo}</span>}
        </div>
        {list.length === 0 ? (
          <EmptyState icon={<FlaskConical size={28} />} title="Noch kein Szenario" description="Beispiel: „Was passiert, wenn die Fenster 14 Tage später kommen?“" action={p.canEdit && <Button variant="primary" onClick={() => setDialog(true)}>Szenario erstellen</Button>} />
        ) : (
          list.map((sc) => {
            const c = compare.get(sc.id)
            const active = p.mode.kind === 'scenario' && p.mode.scenario.id === sc.id
            return (
              <Card key={sc.id} className={active ? 'ring-2 ring-warn/40' : ''}>
                <div className="flex flex-wrap items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{sc.name}</h3>{sc.origin === 'proposal' && <Badge tone="brand"><span className="inline-flex items-center gap-1"><Mail size={11} /> aus Vorschlag</span></Badge>}{sc.origin === 'ai' && <Badge tone="brand">✨ KI-Variante</Badge>}{active && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn">im Gantt geöffnet</span>}</div>
                    {sc.description && <p className="mt-0.5 text-sm text-ink-soft">{sc.description}</p>}
                    <p className="mt-1 text-xs text-ink-faint">Erstellt {formatDateTime(sc.created_at)} · {c?.changed ?? 0} Vorgänge geändert{c && c.added ? ` · ${c.added} neu` : ''}{c && c.removed ? ` · ${c.removed} entfernt` : ''} · {c?.changedDeps ?? 0} Abhängigkeiten geändert{c && c.resources.length ? ` · zusätzlich: ${c.resources.join(', ')}` : ''}</p>
                    {c && c.newViolations.length > 0 && <div className="mt-1 flex items-start gap-1 text-xs text-warn"><AlertTriangle size={12} className="mt-0.5 shrink-0" /><span>{c.newViolations.length} neue Regelverstöße: {c.newViolations.slice(0, 2).join(' · ')}</span></div>}
                    {sc.meta?.risks && sc.meta.risks.length > 0 && <div className="mt-1 text-xs text-ink-soft">Risiken: {sc.meta.risks.join(', ')}</div>}
                  </div>
                  {c && (
                    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
                      <div><div className="text-[11px] text-ink-faint">Projektende vorher</div><div className="font-medium">{formatDate(baseEnd)}</div></div>
                      <ArrowRight size={14} className="text-ink-faint" />
                      <div><div className="text-[11px] text-ink-faint">Szenario</div><div className="font-medium">{formatDate(c.end)}</div></div>
                      <div className="pl-2"><div className="text-[11px] text-ink-faint">Differenz</div><div className="font-medium"><Delta days={c.shift} suffix=" Tage" /></div></div>
                    </div>
                  )}
                </div>
                {p.canEdit && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" onClick={() => { p.enterScenario(sc); navigate(`/projects/${p.projectId}/gantt`) }}><Play size={13} /> Im Gantt bearbeiten</Button>
                    <Button size="sm" onClick={() => apply(sc)}><Check size={13} /> Szenario übernehmen</Button>
                    <Button size="sm" variant="ghost" className="text-danger" onClick={async () => { if (confirm('Szenario löschen?')) { await api.projects.removeScenario(p.projectId, sc.id); if (active) p.exitScenario(); await load() } }}><Trash2 size={13} /> Löschen</Button>
                  </div>
                )}
              </Card>
            )
          })
        )}
      </div>
      <Modal open={dialog} onClose={() => setDialog(false)} title="Szenario erstellen" width="sm" footer={<><Button variant="ghost" onClick={() => setDialog(false)}>Abbrechen</Button><Button variant="primary" onClick={create}>Erstellen & öffnen</Button></>}>
        <div className="space-y-3">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Fenster 14 Tage später" autoFocus /></Field>
          <Field label="Beschreibung"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Annahme und Fragestellung" /></Field>
        </div>
      </Modal>
    </div>
  )
}
