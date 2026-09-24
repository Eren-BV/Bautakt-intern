/**
 * Arbeitskalender: Arbeitstage, Betriebsurlaub, Schließtage, Sonderschichten; Kalender je
 * Organisation, Gewerk, Firma (und Projekt/Ressource/Vorgang über die jeweiligen Stellen).
 * Gesetzliche Feiertage werden aus der Region berechnet (Org-Standard bzw. je Kalender)
 * und nicht als Ausnahmen gespeichert. Änderungen fließen direkt in die Engine.
 */

import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Plus, Trash2, Star, Info } from 'lucide-react'
import { api } from '../lib/api'
import { useOrg } from '../store/org'
import { useAuth } from '../store/auth'
import { useToast } from '../store/toast'
import { Badge, Button, Card, Checkbox, Field, IconButton, Input, Modal, PageHeader, Select } from '../components/ui'
import type { CalendarExceptionType, ProjectCalendar } from '../../shared/types'
import { formatDate } from '../../shared/engine/dates'
import { HOLIDAY_REGIONS, holidaysFor, regionName } from '../../shared/engine/holidays'

const WEEKDAYS = [{ d: 1, l: 'Mo' }, { d: 2, l: 'Di' }, { d: 3, l: 'Mi' }, { d: 4, l: 'Do' }, { d: 5, l: 'Fr' }, { d: 6, l: 'Sa' }, { d: 0, l: 'So' }]
const EX_LABELS: Record<CalendarExceptionType, string> = { holiday: 'Feiertag', vacation: 'Betriebsurlaub', nonworking: 'Arbeitsfrei', working: 'Arbeitstag (Ausnahme)' }

export function CalendarPage() {
  const org = useOrg()
  const { can } = useAuth()
  const toast = useToast()
  const ro = !can('calendar.manage')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newCal, setNewCal] = useState<{ name: string; scope: 'org' | 'trade' | 'company'; trade_id: string; company_id: string; holiday_region: string; working_days: number[] } | null>(null)
  const [newEx, setNewEx] = useState<{ from: string; to: string; type: CalendarExceptionType; name: string } | null>(null)
  const [holidayYear, setHolidayYear] = useState(new Date().getFullYear())
  const cal = org.calendars.find((c) => c.id === selectedId) ?? org.defaultCalendar ?? org.calendars[0]
  const exceptions = useMemo(() => org.exceptions.filter((e) => e.calendar_id === cal?.id).sort((a, b) => a.date.localeCompare(b.date)), [org.exceptions, cal])
  const effectiveRegion = cal?.holiday_region ?? org.org.holiday_region
  const holidays = useMemo(() => holidaysFor(holidayYear, effectiveRegion), [holidayYear, effectiveRegion])
  const scopeLabel = (c: ProjectCalendar) => (c.company_id ? `Firma: ${org.companyName(c.company_id)}` : c.trade_id ? `Gewerk: ${org.tradeName(c.trade_id)}` : c.project_id ? 'Projektkalender' : 'Organisation')

  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn()
      await org.reload()
      if (msg) toast.push(msg, 'success')
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const toggleDay = (c: ProjectCalendar, d: number) => {
    const days = c.working_days.includes(d) ? c.working_days.filter((x) => x !== d) : [...c.working_days, d].sort()
    if (days.length === 0) return toast.push('Mindestens ein Arbeitstag ist nötig.', 'error')
    void run(() => api.calendars.update(c.id, { working_days: days }))
  }
  const addRange = () => {
    if (!newEx || !newEx.from) return
    const items: { date: string; type: string; name: string }[] = []
    const from = new Date(newEx.from), to = new Date(newEx.to || newEx.from)
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) items.push({ date: d.toISOString().slice(0, 10), type: newEx.type, name: newEx.name })
    void run(() => api.calendars.addExceptions(cal!.id, items), `${items.length} Tag(e) eingetragen.`)
    setNewEx(null)
  }

  return (
    <div className="mx-auto max-w-[1200px] p-4 sm:p-6">
      <PageHeader title="Kalender" subtitle="Arbeitstage, Feiertage (aus der Region berechnet), Betriebsurlaub und Schließtage – Grundlage aller Terminberechnungen" actions={!ro && <Button variant="primary" onClick={() => setNewCal({ name: '', scope: 'org', trade_id: '', company_id: '', holiday_region: '', working_days: [1, 2, 3, 4, 5] })}><Plus size={15} /> Kalender</Button>} />
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm text-ink-soft"><Info size={15} className="mt-0.5 shrink-0 text-ink-faint" /><div><b>Schichten:</b> Vorgang → Ressource → Firma → Gewerk → Projekt → Organisation. Je Datum entscheidet die spezifischste Schicht mit einer Ausnahme; sonst gilt: gesetzlicher Feiertag der Region = frei, dann die Wochentagsregel. So gelten Betriebsurlaub einer Firma und Schließtage des Projekts gleichzeitig. Standard-Region: <b>{regionName(org.org.holiday_region)}</b> (Einstellungen), je Projekt änderbar.</div></div>
      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <Card title="Kalender" padded={false}>
          <ul className="divide-y divide-line">
            {org.calendars.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setSelectedId(c.id)} className={clsx('flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-surface-2', cal?.id === c.id && 'bg-brand-soft/60')}>
                  <div className="min-w-0 flex-1"><div className="truncate font-medium">{c.name}</div><div className="text-xs text-ink-faint">{scopeLabel(c)} · {c.working_days.length} Tage/Woche{c.holiday_region ? ` · ${regionName(c.holiday_region)}` : ''}</div></div>
                  {c.is_default && <Star size={14} className="fill-warn text-warn" />}
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {cal && (
          <div className="space-y-6">
            <Card title={cal.name} actions={!ro && <>{!cal.is_default && <Button size="sm" onClick={() => run(() => api.calendars.update(cal.id, { is_default: true }), 'Standardkalender gesetzt.')}><Star size={13} /> Als Standard</Button>}{!cal.is_default && <Button size="sm" variant="ghost" className="text-danger" onClick={() => confirm('Kalender löschen?') && run(() => api.calendars.remove(cal.id))}><Trash2 size={13} /></Button>}</>}>
              <div className="text-xs font-medium text-ink-soft">Arbeitstage</div>
              <div className="mt-2 flex gap-2">
                {WEEKDAYS.map((w) => (
                  <button key={w.d} type="button" disabled={ro} onClick={() => toggleDay(cal, w.d)} className={clsx('h-10 w-12 rounded-lg border text-sm font-medium transition', cal.working_days.includes(w.d) ? 'border-brand bg-brand text-white' : 'border-line bg-surface text-ink-faint hover:bg-surface-2')}>{w.l}</button>
                ))}
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Field label="Name"><Input defaultValue={cal.name} disabled={ro} onBlur={(e) => e.target.value !== cal.name && run(() => api.calendars.update(cal.id, { name: e.target.value }))} /></Field>
                <Field label="Feiertagsregion" hint="Leer = Region des Projekts (z. B. Firma aus anderem Bundesland)"><Select value={cal.holiday_region ?? ''} disabled={ro} onChange={(e) => run(() => api.calendars.update(cal.id, { holiday_region: e.target.value || null }))}><option value="">– wie Projekt –</option>{HOLIDAY_REGIONS.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</Select></Field>
                <Field label="Gilt für Gewerk" hint="Leer = kein Gewerkskalender"><Select value={cal.trade_id ?? ''} disabled={ro || cal.is_default || !!cal.company_id} onChange={(e) => run(() => api.calendars.update(cal.id, { trade_id: e.target.value || null }))}><option value="">–</option>{org.trades.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
                <Field label="Gilt für Firma" hint="Firmenkalender: Betriebsurlaub, Mo–Sa …"><Select value={cal.company_id ?? ''} disabled={ro || cal.is_default || !!cal.trade_id} onChange={(e) => run(() => api.calendars.update(cal.id, { company_id: e.target.value || null }))}><option value="">–</option>{org.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
              </div>
            </Card>
            <Card title={`Gesetzliche Feiertage ${holidayYear} – ${regionName(effectiveRegion)}`} padded={false} actions={<div className="flex items-center gap-1"><Input type="number" value={holidayYear} onChange={(e) => setHolidayYear(Number(e.target.value))} className="h-8 w-20 text-xs" /></div>}>
              <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-3 text-xs text-ink-soft">{holidays.map((h) => <span key={h.date}><span className="tabular-nums">{formatDate(h.date)}</span> {h.name}</span>)}</div>
              <p className="border-t border-line px-4 py-2 text-[11px] text-ink-faint">Werden automatisch berechnet und in jeder Terminberechnung als arbeitsfrei berücksichtigt. Soll an einem Feiertag gearbeitet werden, tragen Sie eine Ausnahme „Arbeitstag“ ein.</p>
            </Card>
            <Card title={`Ausnahmen (${exceptions.length})`} padded={false} actions={!ro && <Button size="sm" variant="primary" onClick={() => setNewEx({ from: '', to: '', type: 'vacation', name: 'Betriebsurlaub' })}><Plus size={13} /> Zeitraum</Button>}>
              <div className="max-h-[480px] overflow-y-auto">
                <table className="data-table w-full text-sm">
                  <thead><tr><th>Datum</th><th>Art</th><th>Bezeichnung</th><th /></tr></thead>
                  <tbody>
                    {exceptions.map((e) => (
                      <tr key={e.id}><td className="whitespace-nowrap">{formatDate(e.date)}</td><td><Badge tone={e.type === 'holiday' ? 'brand' : e.type === 'working' ? 'ok' : 'neutral'}>{EX_LABELS[e.type]}</Badge></td><td className="text-ink-soft">{e.name}</td><td className="text-right">{!ro && <IconButton title="Entfernen" onClick={() => run(() => api.calendars.removeException(cal.id, e.id))}><Trash2 size={14} /></IconButton>}</td></tr>
                    ))}
                    {exceptions.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-ink-faint">Keine Ausnahmen – nur die Wochentage gelten.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}
      </div>

      <Modal open={!!newCal} onClose={() => setNewCal(null)} title="Neuer Kalender" width="sm" footer={<><Button variant="ghost" onClick={() => setNewCal(null)}>Abbrechen</Button><Button variant="primary" disabled={!newCal?.name} onClick={() => { void run(() => api.calendars.create({ name: newCal!.name, working_days: newCal!.working_days, trade_id: newCal!.scope === 'trade' ? newCal!.trade_id || null : null, company_id: newCal!.scope === 'company' ? newCal!.company_id || null : null, holiday_region: newCal!.holiday_region || null }), 'Kalender angelegt.'); setNewCal(null) }}>Anlegen</Button></>}>
        {newCal && (
          <div className="space-y-3">
            <Field label="Name" required><Input value={newCal.name} onChange={(e) => setNewCal({ ...newCal, name: e.target.value })} placeholder="z. B. Estrich (Mo–Sa) oder Firma X (Betriebsurlaub)" autoFocus /></Field>
            <Field label="Gilt für"><Select value={newCal.scope} onChange={(e) => setNewCal({ ...newCal, scope: e.target.value as 'org' | 'trade' | 'company' })}><option value="org">Allgemein (Organisation)</option><option value="trade">Ein Gewerk</option><option value="company">Eine Firma</option></Select></Field>
            {newCal.scope === 'trade' && <Field label="Gewerk"><Select value={newCal.trade_id} onChange={(e) => setNewCal({ ...newCal, trade_id: e.target.value })}><option value="">– wählen –</option>{org.trades.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>}
            {newCal.scope === 'company' && <Field label="Firma"><Select value={newCal.company_id} onChange={(e) => setNewCal({ ...newCal, company_id: e.target.value })}><option value="">– wählen –</option>{org.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>}
            <Field label="Feiertagsregion" hint="Leer = Region des Projekts"><Select value={newCal.holiday_region} onChange={(e) => setNewCal({ ...newCal, holiday_region: e.target.value })}><option value="">– wie Projekt –</option>{HOLIDAY_REGIONS.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</Select></Field>
            <div className="flex flex-wrap gap-2">{WEEKDAYS.map((w) => <Checkbox key={w.d} label={w.l} checked={newCal.working_days.includes(w.d)} onChange={(e) => setNewCal({ ...newCal, working_days: e.target.checked ? [...newCal.working_days, w.d] : newCal.working_days.filter((x) => x !== w.d) })} />)}</div>
          </div>
        )}
      </Modal>
      <Modal open={!!newEx} onClose={() => setNewEx(null)} title="Zeitraum eintragen" width="sm" footer={<><Button variant="ghost" onClick={() => setNewEx(null)}>Abbrechen</Button><Button variant="primary" disabled={!newEx?.from} onClick={addRange}>Eintragen</Button></>}>
        {newEx && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3"><Field label="Von" required><Input type="date" value={newEx.from} onChange={(e) => setNewEx({ ...newEx, from: e.target.value })} /></Field><Field label="Bis"><Input type="date" value={newEx.to} onChange={(e) => setNewEx({ ...newEx, to: e.target.value })} /></Field></div>
            <Field label="Art"><Select value={newEx.type} onChange={(e) => setNewEx({ ...newEx, type: e.target.value as CalendarExceptionType })}>{(Object.keys(EX_LABELS) as CalendarExceptionType[]).map((t) => <option key={t} value={t}>{EX_LABELS[t]}</option>)}</Select></Field>
            <Field label="Bezeichnung"><Input value={newEx.name} onChange={(e) => setNewEx({ ...newEx, name: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </div>
  )
}
