import { useEffect, useMemo, useState } from 'react'
import { api, type PortfolioEntry } from '../lib/api'
import { PageHeader, Spinner, ErrorBox } from '../components/ui'
import { LookaheadView, type LookaheadSource } from '../components/LookaheadView'
import { computeSchedule } from '../../shared/engine/schedule'
import { useOrg } from '../store/org'
import { useAuth } from '../store/auth'

/** Baut aus Portfolio-Daten die Engine-Ergebnisse je Projekt (Termine sind serverseitig bereits berechnet) */
export function usePortfolioSources(data: PortfolioEntry[] | null): LookaheadSource[] {
  const org = useOrg()
  return useMemo<LookaheadSource[]>(() => {
    if (!data || !org.loaded) return []
    return data
      .filter((e) => e.project.state === 'active')
      .map((e) => ({
        project: e.project,
        tasks: e.tasks,
        dependencies: e.dependencies,
        constraints: e.constraints,
        sections: e.sections,
        sched: computeSchedule({ projectId: e.project.id, projectStart: e.project.start_date, projectCalendarId: e.project.calendar_id, tasks: e.tasks, dependencies: e.dependencies, calendars: org.calendars, exceptions: org.exceptions, holidayRegion: e.project.holiday_region, resources: org.resources }),
      }))
  }, [data, org])
}

export function OrgLookaheadPage() {
  const { session } = useAuth()
  const [data, setData] = useState<PortfolioEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.portfolio().then(setData).catch((e) => setError(e.message))
  }, [])
  const sources = usePortfolioSources(data)
  if (error) return <div className="p-6"><ErrorBox message={error} /></div>
  if (!data) return <Spinner />
  return (
    <div className="mx-auto max-w-[1440px] p-4 sm:p-6">
      <PageHeader title="Terminvorschau" subtitle="Kommende Arbeiten über alle aktiven Projekte" />
      <LookaheadView title={session?.org.name ?? ''} sources={sources} showProjectFilter />
    </div>
  )
}
