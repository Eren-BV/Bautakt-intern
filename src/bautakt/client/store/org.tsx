/**
 * Organisationsweite Stammdaten (Kategorien, Firmen, Ressourcen, Mitglieder, Kalender)
 * einmal laden, überall nachschlagen. `reload()` nach Mutationen.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { OrgData, Trade, Company, Resource, User, ProjectCalendar, Organization } from '../../shared/types'
import { api } from '../lib/api'
import { useAuth } from './auth'

interface OrgState extends OrgData {
  loaded: boolean
  reload(): Promise<void>
  tradeById: Map<string, Trade>
  companyById: Map<string, Company>
  resourceById: Map<string, Resource>
  userById: Map<string, User>
  tradeName(id: string | null | undefined): string
  companyName(id: string | null | undefined): string
  userName(id: string | null | undefined): string
  resourceName(id: string | null | undefined): string
  tradeColor(id: string | null | undefined): string
  defaultCalendar: ProjectCalendar | null
}

const EMPTY_ORG: Organization = { id: '', name: '', slug: '', holiday_region: 'DE-BY', created_at: '' }
const EMPTY: OrgData = { org: EMPTY_ORG, trades: [], companies: [], contacts: [], resources: [], members: [], calendars: [], exceptions: [] }
const OrgContext = createContext<OrgState | null>(null)

export function OrgProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const [data, setData] = useState<OrgData>(EMPTY)
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    if (!session) return
    const d = await api.org.get()
    setData(d)
    setLoaded(true)
  }, [session])

  useEffect(() => {
    setLoaded(false)
    setData(EMPTY)
    void reload()
  }, [reload])

  const value = useMemo<OrgState>(() => {
    const tradeById = new Map(data.trades.map((t) => [t.id, t]))
    const companyById = new Map(data.companies.map((c) => [c.id, c]))
    const resourceById = new Map(data.resources.map((r) => [r.id, r]))
    const userById = new Map(data.members.filter((m) => m.user).map((m) => [m.user_id, m.user!]))
    return {
      ...data,
      loaded,
      reload,
      tradeById,
      companyById,
      resourceById,
      userById,
      tradeName: (id) => (id && tradeById.get(id)?.name) || '–',
      companyName: (id) => (id && companyById.get(id)?.name) || '–',
      userName: (id) => (id && userById.get(id)?.name) || '–',
      resourceName: (id) => (id && resourceById.get(id)?.name) || '–',
      tradeColor: (id) => (id && tradeById.get(id)?.color) || '#64748b',
      defaultCalendar: data.calendars.find((c) => c.is_default) ?? null,
    }
  }, [data, loaded, reload])

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

export function useOrg(): OrgState {
  const ctx = useContext(OrgContext)
  if (!ctx) throw new Error('useOrg außerhalb von OrgProvider')
  return ctx
}
