import { useEffect, useMemo, useState } from 'react'
import { Flag } from 'lucide-react'
import clsx from 'clsx'
import { api, type PortfolioEntry } from '../lib/api'
import { navigate } from '../lib/router'
import { Badge, Card, EmptyState, ErrorBox, PageHeader, Spinner, Tabs } from '../components/ui'
import { diffDays, formatDate, todayISO } from '../../shared/engine/dates'

export function OrgMilestonesPage() {
  const [data, setData] = useState<PortfolioEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<'upcoming' | 'all'>('upcoming')
  useEffect(() => {
    api.portfolio().then(setData).catch((e) => setError(e.message))
  }, [])
  const today = todayISO()
  const list = useMemo(() => {
    const out: { project: PortfolioEntry['project']; m: PortfolioEntry['milestones'][number] }[] = []
    for (const e of data ?? []) if (e.project.state === 'active') for (const m of e.milestones) out.push({ project: e.project, m })
    return out.filter((x) => scope === 'all' || (!x.m.done && diffDays(today, x.m.date) >= -30)).sort((a, b) => a.m.date.localeCompare(b.m.date))
  }, [data, scope, today])
  if (error) return <div className="p-6"><ErrorBox message={error} /></div>
  if (!data) return <Spinner />
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <PageHeader title="Meilensteine" subtitle="Projektübergreifend" actions={<Tabs value={scope} onChange={setScope} items={[{ value: 'upcoming', label: 'Anstehend' }, { value: 'all', label: 'Alle' }]} />} />
      {list.length === 0 ? (
        <EmptyState title="Keine Meilensteine" />
      ) : (
        <Card padded={false}>
          <ol className="divide-y divide-line">
            {list.map(({ project, m }) => {
              const d = diffDays(today, m.date)
              return (
                <li key={m.id} className="flex cursor-pointer items-center gap-4 px-4 py-3 hover:bg-surface-2" onClick={() => navigate(`/projects/${project.id}/milestones`)}>
                  <span className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', m.done ? 'bg-ok-soft text-ok' : 'bg-surface-3 text-milestone')}>
                    <Flag size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{m.name}</div>
                    <div className="text-xs text-ink-faint">{project.name}</div>
                  </div>
                  <div className="text-sm font-medium">{formatDate(m.date)}</div>
                  {m.done ? <Badge tone="ok">Erreicht</Badge> : <Badge tone={d < 0 ? 'danger' : d <= 7 ? 'warn' : 'neutral'}>{d < 0 ? `${-d} T überfällig` : d === 0 ? 'Heute' : `in ${d} T`}</Badge>}
                </li>
              )
            })}
          </ol>
        </Card>
      )}
    </div>
  )
}
