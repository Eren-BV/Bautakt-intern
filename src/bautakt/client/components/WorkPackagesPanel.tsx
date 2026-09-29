/**
 * Arbeitspakete verwalten: mitgelieferte ansehen, kopieren, eigene anlegen/löschen.
 * Einfügen in ein Projekt passiert im Terminplan („+ Vorgang → Arbeitspaket einfügen“).
 */

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Copy, Trash2, Diamond, Layers, Package } from 'lucide-react'
import { api } from '../lib/api'
import { useAuth } from '../store/auth'
import { useToast } from '../store/toast'
import { Badge, Button, Card, EmptyState, Spinner } from './ui'
import type { WorkPackageTask, WorkPackageTemplate } from '../../shared/types'
import { CONSTRAINT_KIND_LABELS } from '../../shared/labels'

export function WorkPackagesPanel() {
  const { can } = useAuth()
  const toast = useToast()
  const [list, setList] = useState<(WorkPackageTemplate & { task_count: number })[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ package: WorkPackageTemplate; tasks: WorkPackageTask[] } | null>(null)
  const load = () => api.workPackages.list().then((l) => { setList(l); if (!selected && l[0]) setSelected(l[0].id) }).catch((e) => toast.push(e.message, 'error'))
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (selected) api.workPackages.get(selected).then(setDetail).catch(() => setDetail(null))
  }, [selected])
  if (!list) return <Spinner />
  const copy = async (id: string, name: string) => {
    const n = prompt('Name der Kopie:', `${name} (Kopie)`)
    if (!n) return
    const d = await api.workPackages.create({ name: n, copy_of: id })
    await load()
    setSelected(d.package.id)
  }
  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      <Card title="Arbeitspakete" padded={false}>
        <ul className="divide-y divide-line">
          {list.map((w) => (
            <li key={w.id}>
              <button type="button" onClick={() => setSelected(w.id)} className={clsx('flex w-full flex-col gap-0.5 px-4 py-2.5 text-left hover:bg-surface-2', selected === w.id && 'bg-brand-soft/60')}>
                <div className="flex items-center gap-2"><Package size={14} className="text-ink-faint" /><span className="font-medium">{w.name}</span>{w.is_builtin ? <Badge tone="neutral">mitgeliefert</Badge> : <Badge tone="brand">eigenes</Badge>}</div>
                <div className="text-xs text-ink-faint">{w.task_count} Arbeitsschritte</div>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      {!detail ? <EmptyState title="Arbeitspaket auswählen" /> : (
        <Card title={detail.package.name} padded={false} actions={<>{can('templates.manage') && <Button size="sm" onClick={() => copy(detail.package.id, detail.package.name)}><Copy size={13} /> Kopieren</Button>}{can('templates.manage') && !detail.package.is_builtin && <Button size="sm" variant="ghost" className="text-danger" onClick={async () => { if (confirm('Arbeitspaket löschen?')) { await api.workPackages.remove(detail.package.id); setSelected(null); setDetail(null); await load() } }}><Trash2 size={13} /></Button>}</>}>
          <p className="border-b border-line px-4 py-3 text-sm text-ink-soft">{detail.package.description}</p>
          <table className="data-table w-full text-sm">
            <thead><tr><th>Arbeitsschritt</th><th>Kategorie</th><th className="text-right">Dauer</th><th>Vorgänger</th><th>Voraussetzungen</th></tr></thead>
            <tbody>
              {detail.tasks.map((t) => (
                <tr key={t.key}>
                  <td style={{ paddingLeft: 12 + (t.parent_key ? (detail.tasks.find((x) => x.key === t.parent_key)?.parent_key ? 32 : 16) : 0) }} className={t.type !== 'task' ? 'font-semibold' : ''}><span className="inline-flex items-center gap-1.5">{t.type === 'milestone' && <Diamond size={11} className="fill-milestone text-milestone" />}{t.type === 'group' && <Layers size={12} className="text-ink-faint" />}{t.name}</span></td>
                  <td className="text-xs">{t.trade_name ?? ''}</td>
                  <td className="text-right text-xs">{t.type === 'task' ? `${t.duration} AT` : ''}</td>
                  <td className="text-xs text-ink-soft">{t.dependencies.map((d) => `${detail.tasks.find((x) => x.key === d.predecessor_key)?.name ?? ''} ${d.type}${d.lag_days ? (d.lag_days > 0 ? '+' : '') + d.lag_days : ''}`).join(', ')}</td>
                  <td className="text-xs text-ink-soft">{t.constraints.map((c) => `${CONSTRAINT_KIND_LABELS[c.type]}: ${c.title}`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-3 text-xs text-ink-faint">Einfügen: im Terminplan über „+ Vorgang → Arbeitspaket einfügen“ – Abhängigkeiten und Voraussetzungen werden mit übernommen, die Termine berechnet die Engine.</p>
        </Card>
      )}
    </div>
  )
}
