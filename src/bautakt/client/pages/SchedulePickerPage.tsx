/** „Terminplan“ in der Hauptnavigation: springt zum zuletzt geöffneten Projekt oder lässt wählen. */

import { useEffect, useState } from 'react'
import { GanttChartSquare } from 'lucide-react'
import { api } from '../lib/api'
import { navigate } from '../lib/router'
import { Card, HealthDot, PageHeader, Spinner } from '../components/ui'
import type { ProjectSummary } from '../../shared/types'
import { formatDate } from '../../shared/engine/dates'

export function SchedulePickerPage() {
  const [list, setList] = useState<ProjectSummary[] | null>(null)
  useEffect(() => {
    let last: string | null = null
    try {
      last = localStorage.getItem('bautakt.lastProject')
    } catch {
      /* ignore */
    }
    api.projects.list().then((d) => {
      if (last && d.summaries.some((s) => s.project.id === last)) navigate(`/projects/${last}/gantt`, { replace: true })
      else if (d.summaries.length === 1) navigate(`/projects/${d.summaries[0].project.id}/gantt`, { replace: true })
      else setList(d.summaries)
    })
  }, [])
  if (!list) return <Spinner />
  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader title="Terminplan" subtitle="Welches Projekt möchten Sie öffnen?" />
      <Card padded={false}>
        <ul className="divide-y divide-line">
          {list.map((s) => (
            <li key={s.project.id}>
              <button type="button" onClick={() => navigate(`/projects/${s.project.id}/gantt`)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2">
                <HealthDot health={s.health} />
                <div className="min-w-0 flex-1"><div className="font-medium">{s.project.name}</div><div className="text-xs text-ink-faint">{s.project.number} · {formatDate(s.project.start_date)} – {formatDate(s.forecast_end)} · {s.progress} %</div></div>
                <GanttChartSquare size={16} className="text-ink-faint" />
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
