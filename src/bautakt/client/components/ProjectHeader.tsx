/**
 * Kopf jeder Projektseite: Name, Ampel, Kernaussage (Wo stehen wir? Abweichung?).
 */

import clsx from 'clsx'
import { useProject } from '../store/project'
import { HealthBadge, Delta, Badge } from './ui'
import { formatDate } from '../../shared/engine/dates'
import { PROJECT_STATE_LABELS } from '../../shared/labels'

export function ProjectHeader({ title, compact, actions }: { title?: string; compact?: boolean; actions?: React.ReactNode }) {
  const p = useProject()
  const a = p.analysis
  const project = p.bundle?.project
  if (!project) return null
  return (
    <>
    <div className={clsx('no-print flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface', compact ? 'px-4 py-2' : 'px-6 py-4')}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className={clsx('truncate font-semibold tracking-tight', compact ? 'text-base' : 'text-xl')}>{project.name}</h1>
          {a && <HealthBadge health={a.health} />}
          {project.state !== 'active' && <Badge tone="muted">{PROJECT_STATE_LABELS[project.state]}</Badge>}
          {title && <span className="text-sm text-ink-faint">· {title}</span>}
        </div>
        {!compact && <div className="text-xs text-ink-faint">{project.number} · {project.address}{project.city ? `, ${project.city}` : ''} · Kunde: {project.customer || '–'}</div>}
      </div>
      {a && (
        <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-soft">
          <span>Fortschritt <b className="text-ink">{a.progress} %</b></span>
          <span>{a.baseline_end ? 'Ursprünglich' : 'Ziel'} <b className="text-ink">{formatDate(a.baseline_end ?? project.target_end_date)}</b></span>
          <span>Prognose <b className="text-ink">{formatDate(a.forecast_end)}</b></span>
          <span>Abweichung <Delta days={a.variance_days} /></span>
        </div>
      )}
      {actions}
    </div>
    {p.mode.kind === 'scenario' && (
      <div className="no-print flex items-center gap-2 border-b border-warn/40 bg-warn-soft px-4 py-1.5 text-xs text-warn">
        Szenario „{p.mode.scenario.name}“ geöffnet – Änderungen und Kennzahlen beziehen sich auf das Szenario, nicht auf den echten Plan.
        <button type="button" className="ml-auto font-medium underline" onClick={p.exitScenario}>Szenario verlassen</button>
      </div>
    )}
    </>
  )
}
