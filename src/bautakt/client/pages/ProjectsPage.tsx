import { useEffect, useMemo, useState } from 'react'
import { FolderKanban, Plus, Search, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import * as jarvisBus from '../jarvis/bus'
import { navigate } from '../lib/router'
import { Button, Delta, EmptyState, ErrorBox, HealthBadge, HealthDot, IconButton, Input, Modal, PageHeader, ProgressBar, Select, Spinner, Tabs } from '../components/ui'
import type { ProjectSummary, ProjectState, ProjectGroup } from '../../shared/types'
import { PLANNING_KIND_LABELS, PROJECT_STATE_LABELS, PROJECT_TYPE_LABELS } from '../../shared/labels'
import { formatDate } from '../../shared/engine/dates'
import { useAuth } from '../store/auth'

export function ProjectsPage() {
  const { can } = useAuth()
  const [data, setData] = useState<ProjectSummary[] | null>(null)
  const [groups, setGroups] = useState<ProjectGroup[]>([])
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [state, setState] = useState<ProjectState | 'all'>('all')
  const [health, setHealth] = useState<'all' | 'green' | 'yellow' | 'red'>('all')
  const [groupFilter, setGroupFilter] = useState<'all' | 'none' | string>('all')
  const [groupsOpen, setGroupsOpen] = useState(false)
  const load = () => api.projects.list().then((d) => setData(d.summaries)).catch((e) => setError(e.message))
  const loadGroups = () => api.projectGroups.list().then(setGroups).catch(() => {})
  useEffect(() => {
    void load()
    void loadGroups()
    // Jarvis hat ein Projekt angelegt oder entfernt → Liste sofort aktualisieren
    return jarvisBus.on('data-changed', (e) => {
      if (e.scope === 'projects') void load()
    })
  }, [])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (data ?? [])
      .filter((p) => state === 'all' || p.project.state === state)
      .filter((p) => health === 'all' || p.health === health)
      .filter((p) => groupFilter === 'all' || (groupFilter === 'none' ? !p.project.group_id : p.project.group_id === groupFilter))
      .filter((p) => !s || [p.project.name, p.project.number, p.project.customer, p.project.city, p.project.address].some((x) => x.toLowerCase().includes(s)))
      .sort((a, b) => a.project.start_date.localeCompare(b.project.start_date))
  }, [data, q, state, health, groupFilter])

  const assignGroup = async (id: string, groupId: string) => {
    await api.projects.update(id, { group_id: groupId || null })
    await load()
  }

  if (error) return <div className="p-6"><ErrorBox message={error} onRetry={load} /></div>
  if (!data) return <Spinner />

  const groupById = new Map(groups.map((g) => [g.id, g]))
  const sections: { id: string | null; name: string; items: ProjectSummary[] }[] = groupFilter === 'all'
    ? [...groups.map((g) => ({ id: g.id, name: g.name, items: list.filter((p) => p.project.group_id === g.id) })).filter((s) => s.items.length), { id: null, name: 'Ohne Sammelstelle', items: list.filter((p) => !p.project.group_id) }].filter((s) => s.items.length)
    : [{ id: null, name: '', items: list }]

  return (
    <div className="mx-auto max-w-[1440px] p-4 sm:p-6">
      <PageHeader title="Projekte" subtitle={`${data.length} Projekte`} actions={<div className="flex flex-wrap gap-2">{can('project.create') && <Button onClick={() => setGroupsOpen(true)}><FolderKanban size={16} /> Sammelstellen</Button>}{can('project.create') && <Button onClick={() => navigate('/projects/new?kind=internal')}><Plus size={16} /> Interne Aufgabe</Button>}{can('project.create') && <Button variant="primary" onClick={() => navigate('/projects/new')}><Plus size={16} /> Neues Projekt</Button>}</div>} />
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
        {groups.length > 0 && (
          <Select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className="w-52">
            <option value="all">Alle Sammelstellen</option>
            <option value="none">Ohne Sammelstelle</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        )}
        <Tabs value={health} onChange={setHealth} items={[{ value: 'all', label: 'Alle' }, { value: 'green', label: 'Im Plan' }, { value: 'yellow', label: 'Gefährdet' }, { value: 'red', label: 'Verspätet' }]} />
      </div>
      {list.length === 0 ? (
        <EmptyState title="Keine Projekte gefunden" description={data.length ? 'Filter anpassen oder Suche leeren.' : 'Legen Sie Ihr erstes Projekt an.'} />
      ) : (
        <div className="space-y-6">
          {sections.map((sec) => (
            <div key={sec.id ?? 'none'}>
              {sec.name && <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink-soft"><FolderKanban size={14} className="text-ink-faint" /> {sec.name} <span className="font-normal text-ink-faint">({sec.items.length})</span></h3>}
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {sec.items.map((p) => (
                  <div key={p.project.id} className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition hover:border-line-strong hover:shadow-md">
                    <button type="button" onClick={() => navigate(`/projects/${p.project.id}`)} className="flex flex-col text-left">
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
                    {groups.length > 0 && can('project.create') && (
                      <Select value={p.project.group_id ?? ''} onClick={(e) => e.stopPropagation()} onChange={(e) => void assignGroup(p.project.id, e.target.value)} className="mt-3 h-7 text-xs">
                        <option value="">Ohne Sammelstelle</option>
                        {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </Select>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <GroupsModal open={groupsOpen} onClose={() => setGroupsOpen(false)} groups={groups} onChange={setGroups} />
    </div>
  )
}

function GroupsModal({ open, onClose, groups, onChange }: { open: boolean; onClose: () => void; groups: ProjectGroup[]; onChange: (g: ProjectGroup[]) => void }) {
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<Record<string, string>>({})
  return (
    <Modal open={open} onClose={onClose} title="Sammelstellen">
      <div className="space-y-2">
        {groups.length === 0 && <div className="text-sm text-ink-faint">Noch keine Sammelstelle angelegt.</div>}
        {groups.map((g) => (
          <div key={g.id} className="flex items-center gap-2">
            <Input
              value={editing[g.id] ?? g.name}
              onChange={(e) => setEditing((s) => ({ ...s, [g.id]: e.target.value }))}
              onBlur={async () => {
                const v = (editing[g.id] ?? g.name).trim()
                if (!v || v === g.name) return
                onChange(await api.projectGroups.update(g.id, v))
              }}
              className="h-8 flex-1 text-sm"
            />
            <IconButton title="Löschen" onClick={async () => { if (confirm(`Sammelstelle "${g.name}" löschen? Projekte bleiben erhalten, verlieren aber die Zuordnung.`)) onChange(await api.projectGroups.remove(g.id)) }}><Trash2 size={13} /></IconButton>
          </div>
        ))}
      </div>
      <form
        className="mt-4 flex items-center gap-2 border-t border-line pt-3"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim()) return
          onChange(await api.projectGroups.create(name.trim()))
          setName('')
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name der neuen Sammelstelle" className="h-8 flex-1 text-sm" />
        <Button type="submit" variant="primary"><Plus size={14} /> Anlegen</Button>
      </form>
    </Modal>
  )
}
