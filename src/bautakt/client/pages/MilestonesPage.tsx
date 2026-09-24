import { Flag } from 'lucide-react'
import clsx from 'clsx'
import { useProject } from '../store/project'
import { navigate } from '../lib/router'
import { ProjectHeader } from '../components/ProjectHeader'
import { Badge, Card, Delta, EmptyState, Spinner } from '../components/ui'
import { formatDate, fromDayNumber, toDayNumber, diffDays } from '../../shared/engine/dates'

export function MilestonesPage() {
  const p = useProject()
  if (!p.bundle || !p.analysis) return <Spinner />
  const sched = p.analysis.current
  const baselineTasks = p.analysis.baselineTasks
  const list = p.plan.tasks
    .filter((t) => t.type === 'milestone')
    .map((t) => ({ t, s: sched.tasks.get(t.id)!, bl: baselineTasks.get(t.id) }))
    .sort((a, b) => a.s.start - b.s.start)
  return (
    <div>
      <ProjectHeader title="Meilensteine" />
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        {list.length === 0 ? (
          <EmptyState title="Keine Meilensteine" description="Fügen Sie Meilensteine im Bauzeitenplan hinzu (Rechtsklick → Meilenstein hinzufügen)." />
        ) : (
          <Card padded={false}>
            <ol className="divide-y divide-line">
              {list.map(({ t, s, bl }) => {
                const d = diffDays(p.today, fromDayNumber(s.start))
                const done = t.status === 'done'
                return (
                  <li key={t.id} className="flex cursor-pointer items-center gap-4 px-4 py-3 hover:bg-surface-2" onClick={() => navigate(`/projects/${p.projectId}/gantt?task=${t.id}`)}>
                    <span className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', done ? 'bg-ok-soft text-ok' : s.isCritical ? 'bg-danger-soft text-danger' : 'bg-surface-3 text-milestone')}>
                      <Flag size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{t.name}</div>
                      <div className="text-xs text-ink-faint">
                        {p.plan.tasks.find((x) => x.id === t.parent_id)?.name ?? ''}
                        {bl ? ` · Baseline ${formatDate(bl.start_date)}` : ''}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium">{formatDate(fromDayNumber(s.start))}</div>
                      <div className="text-xs">{bl && <Delta days={s.start - toDayNumber(bl.start_date)} suffix=" T" />}</div>
                    </div>
                    {done ? <Badge tone="ok">Erreicht</Badge> : <Badge tone={d < 0 ? 'danger' : d <= 7 ? 'warn' : 'neutral'}>{d < 0 ? `${-d} T überfällig` : d === 0 ? 'Heute' : `in ${d} T`}</Badge>}
                  </li>
                )
              })}
            </ol>
          </Card>
        )}
      </div>
    </div>
  )
}
