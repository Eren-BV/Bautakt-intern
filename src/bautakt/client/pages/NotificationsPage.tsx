import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Bell } from 'lucide-react'
import { api } from '../lib/api'
import { navigate } from '../lib/router'
import { Badge, Button, Card, EmptyState, PageHeader, Spinner } from '../components/ui'
import type { AppNotification } from '../../shared/types'
import { formatDateTime } from '../../shared/engine/dates'

export function NotificationsPage() {
  const [items, setItems] = useState<AppNotification[] | null>(null)
  const load = () => api.notifications.list().then(setItems).catch(() => setItems([]))
  useEffect(() => {
    void load()
  }, [])
  if (!items) return <Spinner />
  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader title="Benachrichtigungen" subtitle={`${items.filter((n) => !n.read_at).length} ungelesen`} actions={<Button onClick={() => api.notifications.readAll().then(load)}>Alle als gelesen markieren</Button>} />
      {items.length === 0 ? <EmptyState icon={<Bell size={28} />} title="Keine Benachrichtigungen" /> : (
        <Card padded={false}>
          <ul className="divide-y divide-line">
            {items.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => { if (!n.read_at) api.notifications.read(n.id).then(load); if (n.project_id) navigate(`/projects/${n.project_id}`) }} className={clsx('flex w-full flex-col gap-0.5 px-4 py-3 text-left hover:bg-surface-2', !n.read_at && 'bg-brand-soft/30')}>
                  <div className="flex items-center gap-2"><Badge tone={n.severity === 'critical' ? 'danger' : n.severity === 'warning' ? 'warn' : 'brand'} dot>{n.severity === 'critical' ? 'Kritisch' : n.severity === 'warning' ? 'Warnung' : 'Info'}</Badge><span className="ml-auto text-xs text-ink-faint">{formatDateTime(n.created_at)}</span></div>
                  <div className="font-medium">{n.title}</div>
                  <div className="text-sm text-ink-soft">{n.message}</div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
