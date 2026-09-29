/**
 * Ressourcen & Kategorien: Kategorien, Firmen, Teams/Personen/Geräte verwalten;
 * Auslastungs-Ansicht mit Überlastungen über alle aktiven Projekte.
 */

import { useEffect, useState, type FormEvent } from 'react'
import { Plus, Trash2, AlertTriangle, Pencil, Users } from 'lucide-react'
import { CompanyContactsDialog } from '../components/CompanyContactsDialog'
import { api } from '../lib/api'
import { useOrg } from '../store/org'
import { useAuth } from '../store/auth'
import { useToast } from '../store/toast'
import { Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Tabs } from '../components/ui'
import type { Company, Resource, ResourceType, Trade } from '../../shared/types'
import type { ResourceConflict } from '../../shared/engine/analysis'
import { formatDate } from '../../shared/engine/dates'

type Tab = 'resources' | 'trades' | 'companies' | 'load' | 'experience'

export function ResourcesPage() {
  const org = useOrg()
  const { can } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('load')
  const [conflicts, setConflicts] = useState<ResourceConflict[] | null>(null)
  const [experience, setExperience] = useState<{ by_trade: { trade_id: string | null; count: number; planned: number; actual: number; delayed: number; ratio: number | null }[] } | null>(null)
  const [edit, setEdit] = useState<{ kind: 'trade'; item: Partial<Trade> } | { kind: 'company'; item: Partial<Company> } | { kind: 'resource'; item: Partial<Resource> } | null>(null)
  const [contactsFor, setContactsFor] = useState<Company | null>(null)
  const ro = !can('resources.manage')
  useEffect(() => {
    api.resources.conflicts().then(setConflicts).catch(() => setConflicts([]))
    api.analytics.durations().then(setExperience).catch(() => setExperience({ by_trade: [] }))
  }, [org])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!edit) return
    try {
      const { id, ...data } = edit.item as { id?: string }
      if (edit.kind === 'trade') id ? await api.trades.update(id, data) : await api.trades.create(data)
      if (edit.kind === 'company') id ? await api.companies.update(id, data) : await api.companies.create(data)
      if (edit.kind === 'resource') id ? await api.resources.update(id, data) : await api.resources.create(data)
      await org.reload()
      setEdit(null)
    } catch (err) {
      toast.push((err as Error).message, 'error')
    }
  }
  const remove = async (kind: 'trade' | 'company' | 'resource', id: string) => {
    if (!confirm('Wirklich löschen?')) return
    try {
      if (kind === 'trade') await api.trades.remove(id)
      if (kind === 'company') await api.companies.remove(id)
      if (kind === 'resource') await api.resources.remove(id)
      await org.reload()
    } catch (err) {
      toast.push((err as Error).message, 'error')
    }
  }
  const setItem = (patch: Record<string, unknown>) => setEdit((e) => (e ? ({ ...e, item: { ...e.item, ...patch } } as typeof e) : e))

  return (
    <div className="mx-auto max-w-[1200px] p-4 sm:p-6">
      <PageHeader title="Ressourcen & Firmen" subtitle="Firmen, Teams und Geräte – und wo sie sich überschneiden" actions={<Tabs value={tab} onChange={setTab} items={[{ value: 'load', label: 'Auslastung' }, { value: 'resources', label: `Ressourcen (${org.resources.length})` }, { value: 'trades', label: `Kategorien (${org.trades.length})` }, { value: 'companies', label: `Firmen (${org.companies.length})` }, { value: 'experience', label: 'Erfahrungswerte' }]} />} />

      {tab === 'load' && (
        <Card title="Überlastungen & Mehrfachbelegung" padded={false}>
          {!conflicts ? <div className="p-6 text-sm text-ink-faint">Wird berechnet …</div> : conflicts.length === 0 ? <div className="px-4 py-8 text-center text-sm text-ink-faint">Keine Ressource ist gleichzeitig auf mehreren Projekten oder über Kapazität eingeplant.</div> : (
            <ul className="divide-y divide-line">
              {conflicts.map((c, i) => (
                <li key={i} className="flex items-start gap-3 px-4 py-3">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
                  <div className="min-w-0 flex-1 text-sm">
                    <div><b>{c.resource.name}</b> ist in KW {c.week.week} ({formatDate(c.week.monday)}) gleichzeitig auf {c.projects.length} Projekt{c.projects.length === 1 ? '' : 'en'} eingeplant.<Badge tone={c.load > Math.max(1, c.resource.capacity) ? 'danger' : 'warn'} className="ml-2">Last {c.load} / Kapazität {c.resource.capacity}</Badge></div>
                    <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">{c.projects.map((p) => <li key={p.project_id}>{p.project_name}: {p.tasks.join(', ')}</li>)}</ul>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'experience' && (
        <Card title="Erfahrungswerte aus abgeschlossenen Vorgängen (lernfähige Datenbasis)" padded={false}>
          {!experience ? <div className="p-6 text-sm text-ink-faint">Wird geladen …</div> : experience.by_trade.length === 0 ? <div className="px-4 py-8 text-center text-sm text-ink-faint">Noch keine abgeschlossenen Vorgänge mit Ist-Dauer.</div> : (
            <table className="data-table w-full text-sm"><thead><tr><th>Kategorie</th><th className="text-right">Abgeschlossene Vorgänge</th><th className="text-right">Plan-Dauer Σ</th><th className="text-right">Ist-Dauer Σ</th><th className="text-right">Ist / Plan</th><th className="text-right">mit Verzögerungsgrund</th></tr></thead>
              <tbody>{experience.by_trade.sort((a, b) => b.count - a.count).map((e) => <tr key={e.trade_id ?? 'none'}><td className="font-medium">{org.tradeName(e.trade_id)}</td><td className="text-right">{e.count}</td><td className="text-right">{e.planned} AT</td><td className="text-right">{e.actual} AT</td><td className="text-right"><Badge tone={e.ratio && e.ratio > 1.1 ? 'danger' : e.ratio && e.ratio < 0.9 ? 'brand' : 'ok'}>{e.ratio !== null ? `${Math.round(e.ratio * 100)} %` : '–'}</Badge></td><td className="text-right">{e.delayed}</td></tr>)}</tbody></table>
          )}
          <p className="px-4 py-3 text-xs text-ink-faint">Gespeichert werden je erledigtem Vorgang Plan- und Ist-Dauer, Menge/Einheit, Kategorie, Projektart, Team und Verzögerungsgrund – Grundlage für spätere Dauervorschläge und KI-Auswertungen.</p>
        </Card>
      )}
      {tab === 'resources' && (
        <Card title="Teams, Personen, Geräte" padded={false} actions={!ro && <Button size="sm" variant="primary" onClick={() => setEdit({ kind: 'resource', item: { type: 'team', capacity: 1 } })}><Plus size={14} /> Ressource</Button>}>
          {org.resources.length === 0 ? <div className="p-4"><EmptyState title="Keine Ressourcen" /></div> : (
            <table className="data-table w-full text-sm"><thead><tr><th>Name</th><th>Typ</th><th>Kategorie</th><th>Firma</th><th className="text-right">Kapazität</th><th /></tr></thead>
              <tbody>{org.resources.map((r) => (
                <tr key={r.id}><td className="font-medium">{r.name}</td><td className="text-xs">{r.type === 'team' ? 'Team' : r.type === 'person' ? 'Person' : 'Gerät'}</td><td className="text-xs">{org.tradeName(r.trade_id)}</td><td className="text-xs">{org.companyName(r.company_id)}</td><td className="text-right">{r.capacity}</td>
                  <td className="text-right whitespace-nowrap">{!ro && <><IconButton title="Bearbeiten" onClick={() => setEdit({ kind: 'resource', item: r })}><Pencil size={14} /></IconButton><IconButton title="Löschen" onClick={() => remove('resource', r.id)}><Trash2 size={14} /></IconButton></>}</td></tr>
              ))}</tbody></table>
          )}
        </Card>
      )}

      {tab === 'trades' && (
        <Card title="Kategorien" padded={false} actions={!ro && <Button size="sm" variant="primary" onClick={() => setEdit({ kind: 'trade', item: { color: '#64748b', sort_order: org.trades.length } })}><Plus size={14} /> Kategorie</Button>}>
          <table className="data-table w-full text-sm"><thead><tr><th>Kategorie</th><th>Farbe</th><th>Firmen</th><th /></tr></thead>
            <tbody>{org.trades.map((t) => (
              <tr key={t.id}><td className="font-medium"><span className="mr-2 inline-block h-3 w-3 rounded-sm align-middle" style={{ background: t.color }} />{t.name}</td><td className="text-xs text-ink-faint">{t.color}</td><td className="text-xs text-ink-soft">{org.companies.filter((c) => c.trade_id === t.id).map((c) => c.name).join(', ') || '–'}</td>
                <td className="text-right whitespace-nowrap">{!ro && <><IconButton title="Bearbeiten" onClick={() => setEdit({ kind: 'trade', item: t })}><Pencil size={14} /></IconButton><IconButton title="Löschen" onClick={() => remove('trade', t.id)}><Trash2 size={14} /></IconButton></>}</td></tr>
            ))}</tbody></table>
        </Card>
      )}

      {tab === 'companies' && (
        <Card title="Firmen" padded={false} actions={!ro && <Button size="sm" variant="primary" onClick={() => setEdit({ kind: 'company', item: {} })}><Plus size={14} /> Firma</Button>}>
          {org.companies.length === 0 ? <div className="p-4"><EmptyState title="Keine Firmen" /></div> : (
            <table className="data-table w-full text-sm"><thead><tr><th>Firma</th><th>Kategorien</th><th>Adresse</th><th>Telefon</th><th>E-Mail (allgemein)</th><th>Ansprechpartner</th><th /></tr></thead>
              <tbody>{org.companies.map((c) => {
                const n = org.contacts.filter((x) => x.company_id === c.id).length
                return (
                <tr key={c.id}><td className="font-medium">{c.name}</td><td className="text-xs">{c.trade_ids.map((id) => org.tradeName(id)).join(', ') || '–'}</td><td className="text-xs">{c.address}</td><td className="text-xs">{c.phone}</td><td className="text-xs">{c.email}</td>
                  <td className="text-xs"><button type="button" className="inline-flex items-center gap-1 text-brand hover:underline" onClick={() => setContactsFor(c)}><Users size={12} /> {n} {n === 1 ? 'Kontakt' : 'Kontakte'}</button></td>
                  <td className="text-right whitespace-nowrap">{!ro && <><IconButton title="Bearbeiten" onClick={() => setEdit({ kind: 'company', item: c })}><Pencil size={14} /></IconButton><IconButton title="Löschen" onClick={() => remove('company', c.id)}><Trash2 size={14} /></IconButton></>}</td></tr>
              )})}</tbody></table>
          )}
        </Card>
      )}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? (edit.item.id ? 'Bearbeiten' : 'Anlegen') : ''} width="sm" footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Abbrechen</Button><Button variant="primary" type="submit" form="res-form">Speichern</Button></>}>
        {edit && (
          <form id="res-form" onSubmit={save} className="space-y-3">
            <Field label="Name" required><Input value={edit.item.name ?? ''} onChange={(e) => setItem({ name: e.target.value })} required autoFocus /></Field>
            {edit.kind === 'trade' && <Field label="Farbe"><Input type="color" value={(edit.item as Trade).color ?? '#64748b'} onChange={(e) => setItem({ color: e.target.value })} className="h-10 w-20 p-1" /></Field>}
            {edit.kind === 'resource' && (
              <Field label="Kategorie"><Select value={(edit.item as Resource).trade_id ?? ''} onChange={(e) => setItem({ trade_id: e.target.value || null })}><option value="">–</option>{org.trades.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
            )}
            {edit.kind === 'company' && (<>
              <Field label="Hauptkategorie"><Select value={(edit.item as Company).trade_id ?? ''} onChange={(e) => { const id = e.target.value || null; const ids = (edit.item as Company).trade_ids ?? []; setItem({ trade_id: id, trade_ids: id && !ids.includes(id) ? [...ids, id] : ids }) }}><option value="">–</option>{org.trades.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
              <Field label="Weitere Kategorien"><div className="flex flex-wrap gap-x-3 gap-y-1">{org.trades.map((t) => <Checkbox key={t.id} label={t.name} checked={((edit.item as Company).trade_ids ?? []).includes(t.id)} onChange={(e) => { const ids = (edit.item as Company).trade_ids ?? []; setItem({ trade_ids: e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id) }) }} />)}</div></Field>
              <Field label="Adresse"><Input value={(edit.item as Company).address ?? ''} onChange={(e) => setItem({ address: e.target.value })} placeholder="Straße, PLZ Ort" /></Field>
              <div className="grid grid-cols-2 gap-3"><Field label="Telefon"><Input value={(edit.item as Company).phone ?? ''} onChange={(e) => setItem({ phone: e.target.value })} /></Field><Field label="Allgemeine E-Mail" hint="für die Absender-Zuordnung (auch per Domain)"><Input type="email" value={(edit.item as Company).email ?? ''} onChange={(e) => setItem({ email: e.target.value })} /></Field></div>
              <Field label="Hauptansprechpartner (Kurzform)" hint="Detaillierte Kontakte mit eigenen E-Mail-Adressen: „Kontakte“ in der Liste"><Input value={(edit.item as Company).contact_name ?? ''} onChange={(e) => setItem({ contact_name: e.target.value })} /></Field>
            </>)}
            {edit.kind === 'resource' && (<>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Typ"><Select value={(edit.item as Resource).type ?? 'team'} onChange={(e) => setItem({ type: e.target.value as ResourceType })}><option value="team">Team</option><option value="person">Person</option><option value="equipment">Gerät</option></Select></Field>
                <Field label="Kapazität" hint="1 = ein Projekt gleichzeitig"><Input type="number" min={0.5} step={0.5} value={(edit.item as Resource).capacity ?? 1} onChange={(e) => setItem({ capacity: Number(e.target.value) })} /></Field>
              </div>
              <Field label="Firma"><Select value={(edit.item as Resource).company_id ?? ''} onChange={(e) => setItem({ company_id: e.target.value || null })}><option value="">– eigene –</option>{org.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
              <Field label="Eigener Kalender" hint="Optional, z. B. Team mit Samstagsarbeit"><Select value={(edit.item as Resource).calendar_id ?? ''} onChange={(e) => setItem({ calendar_id: e.target.value || null })}><option value="">Standard</option>{org.calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            </>)}
          </form>
        )}
      </Modal>
      {contactsFor && <CompanyContactsDialog company={org.companies.find((c) => c.id === contactsFor.id) ?? contactsFor} onClose={() => setContactsFor(null)} />}
    </div>
  )
}
