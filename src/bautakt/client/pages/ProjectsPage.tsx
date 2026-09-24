import { useEffect, useMemo, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { api } from '../lib/api'
import { navigate } from '../lib/router'
import { Button, Delta, EmptyState, ErrorBox, HealthBadge, HealthDot, Input, PageHeader, ProgressBar, Select, Spinner, Tabs } from '../components/ui'
import type { ProjectSummary, ProjectState } from '../../shared/types'
import { PLANNING_KIND_LABELS, PROJECT_STATE_LABELS, PROJECT_TYPE_LABELS } from '../../shared/labels'
import { formatDate } from '../../shared/engine/dates'
import { useAuth } from '../store/auth'

export function ProjectsPage() {
  const { can } = useAuth()
  const [data, setData] = useState<ProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [state, setState] = useState<ProjectState | 'all'>('all')
  const [health, setHealth] = useState<'all' | 'green' | 'yellow' | 'red'>('all')
  const load = () => api.projects.list().then((d) => setData(d.summaries)).catch((e) => setError(e.message))
  useEffect(() => {
    void load()
  }, [])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (data ?? [])
      .filter((p) => state === 'all' || p.project.state === state)
      .filter((p) => health === 'all' || p.health === health)
      .filter((p) => !s || [p.project.name, p.project.number, p.project.customer, p.project.city, p.project.address].some((x) => x.toLowerCase().includes(s)))
      .sort((a, b) => a.project.start_date.localeCompare(b.project.start_date))
  }, [data, q, state, health])

  if (error) return <div className="p-6"><ErrorBox message={error} onRetry={load} /></div>
  if (!data) return <Spinner />

  return (
    <div className="mx-auto max-w-[1440px] p-4 sm:p-6">
      <PageHeader title="Projekte" subtitle={`${data.length} Projekte`} actions={can('project.create') && <div className="flex flex-wrap gap-2"><Button onClick={() => navigate('/projects/new?kind=free')}><Plus size={16} /> Freier Terminplan</Button><Button variant="primary" onClick={() => navigate('/projects/new')}><Plus size={16} /> Neues Projekt</Button></div>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-72 max-w-full">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Projekt, Nummer, Kunde, Ort …" className="pl-9" />
        </div>
        <Select value={state} onChange={(e) => setState(e.target.value as ProjectState | 'all')} className="w-44">
          <option value="all">Alle Status</option>
          {(Object.keys(PROJECT_STATE_LABELS) as ProjectState[]).map((s) => (
            <option key={s} value={s}>{PROJECT_STATE_LABELS[s]}</option>
          ))}
        </Select>
        <Tabs value={health} onChange={setHealth} items={[{ value: 'all', label: 'Alle' }, { value: 'green', label: 'Im Plan' }, { value: 'yellow', label: 'Gefährdet' }, { value: 'red', label: 'Verspätet' }]} />
      </div>
      {list.length === 0 ? (
        <EmptyState title="Keine Projekte gefunden" description={data.length ? 'Filter anpassen oder Suche leeren.' : 'Legen Sie Ihr erstes Projekt an.'} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((p) => (
            <button key={p.project.id} type="button" onClick={() => navigate(`/projects/${p.project.id}`)} className="flex flex-col rounded-xl border border-line bg-surface p-4 text-left shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition hover:border-line-strong hover:shadow-md">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <HealthDot health={p.health} />
                    <span className="truncate font-semibold text-ink">{p.project.name}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-ink-faint">{p.project.number} · {p.project.planning_kind === 'construction' ? PROJECT_TYPE_LABELS[p.project.project_type] : PLANNING_KIND_LABELS[p.project.planning_kind]} · {p.project.city}</div>
                </div>
                <HealthBadge health={p.health} />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div><div className="text-ink-faint">Start</div><div className="font-medium">{formatDate(p.project.start_date)}</div></div>
                <div><div className="text-ink-faint">Prognose</div><div className="font-medium">{formatDate(p.forecast_end)}</div></div>
                <div><div className="text-ink-faint">Abweichung</div><div className="font-medium"><Delta days={p.variance_days} /></div></div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <ProgressBar value={p.progress} className="flex-1" tone={p.health === 'red' ? 'danger' : 'brand'} />
                <span className="text-xs text-ink-soft">{p.progress} %</span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-ink-faint">
                <span>{p.project.planning_kind === 'construction' ? `BL: ${p.site_manager_name || '–'}` : `PL: ${p.project_manager_name || '–'}`}</span>
                <span>{p.done_count}/{p.task_count} Vorgänge</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
