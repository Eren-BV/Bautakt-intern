/**
 * Planprüfung (regelbasiert, deterministisch): Findings als Empfehlungen - keine
 * automatischen Änderungen. Dieselbe Struktur nutzt später „✨ Terminplan prüfen“.
 */

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { X, AlertTriangle, Info, ShieldCheck, ShieldAlert } from 'lucide-react'
import { useProject } from '../../store/project'
import { useOrg } from '../../store/org'
import { checkPlan, type PlanFinding } from '../../../shared/engine/planCheck'
import { effectiveRules, evaluateRules, type PlanRule } from '../../../shared/rules/engine'
import { api } from '../../lib/api'
import { IconButton, Badge } from '../ui'

export function PlanCheckPanel({ onClose, onOpenTask }: { onClose: () => void; onOpenTask: (id: string) => void }) {
  const p = useProject()
  const org = useOrg()
  const [rules, setRules] = useState<PlanRule[] | null>(null)
  useEffect(() => {
    api.rules.list(p.projectId).then((r) => setRules(effectiveRules(r.custom, p.projectId, null, p.bundle?.project.planning_kind === 'construction'))).catch(() => setRules([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.projectId, p.bundle?.project.planning_kind])
  const findings = useMemo<PlanFinding[]>(() => {
    if (!p.analysis) return []
    const base = checkPlan(p.plan.tasks, p.plan.dependencies, p.analysis.current, p.today, { resources: org.resources, assignments: p.bundle?.assignments ?? [] })
    // Baulogische Regeln (Rule Engine) als eigene Findings
    const violations = evaluateRules(rules ?? [], { tasks: p.plan.tasks, dependencies: p.plan.dependencies, sched: p.analysis.current, trades: org.trades, sections: p.bundle?.sections })
    const ruleFindings: PlanFinding[] = violations.map((v, i) => ({ id: `r${i}`, severity: v.severity, rule: `rule:${v.kind}`, taskId: v.task_id, message: `${v.rule_name}: ${v.message}`, recommendation: v.recommendation }))
    const rank = (x: PlanFinding['severity']) => (x === 'critical' ? 2 : x === 'warning' ? 1 : 0)
    return [...base, ...ruleFindings].sort((a, b) => rank(b.severity) - rank(a.severity))
  }, [p.analysis, p.plan, p.today, org.resources, org.trades, p.bundle?.assignments, p.bundle?.sections, rules])
  const critical = findings.filter((f) => f.severity === 'critical').length
  const warnings = findings.filter((f) => f.severity === 'warning').length
  return (
    <aside className="flex h-full flex-col border-l border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        {findings.length === 0 ? <ShieldCheck size={18} className="text-ok" /> : <ShieldAlert size={18} className={critical ? 'text-danger' : 'text-warn'} />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Planprüfung</div>
          <div className="text-[11px] text-ink-faint">{findings.length === 0 ? 'Keine Auffälligkeiten' : `${critical} kritisch · ${warnings} Hinweise · ${findings.length - critical - warnings} Info`}</div>
        </div>
        <IconButton title="Schließen" onClick={onClose}><X size={16} /></IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {findings.length === 0 && <p className="px-4 py-8 text-center text-sm text-ink-faint">Alle Regeln erfüllt: Vorgänger/Nachfolger vorhanden, keine verletzten Abhängigkeiten, Wartezeiten hinterlegt, keine doppelt belegten Teams, keine Regelverstöße ({(rules ?? []).filter((r) => r.enabled).length} Regeln geprüft).</p>}
        <ul className="divide-y divide-line">
          {findings.map((f) => (
            <li key={f.id}>
              <button type="button" onClick={() => f.taskId && onOpenTask(f.taskId)} className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-surface-2">
                {f.severity === 'critical' ? <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" /> : f.severity === 'warning' ? <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" /> : <Info size={15} className="mt-0.5 shrink-0 text-brand" />}
                <div className="min-w-0">
                  <div className={clsx('text-sm', f.severity === 'critical' && 'font-medium')}>{f.message}</div>
                  <div className="text-xs text-ink-faint">{f.recommendation}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <footer className="border-t border-line px-4 py-2 text-[11px] text-ink-faint">
        <Badge tone="neutral">regelbasiert</Badge> Empfehlungen inkl. fachlicher Regeln ({(rules ?? []).filter((r) => r.enabled).length}) – nichts wird automatisch geändert.
      </footer>
    </aside>
  )
}
