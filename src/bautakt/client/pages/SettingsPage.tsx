/**
 * Einstellungen: Organisation (Name, Standard-Feiertagsregion), Integrationen (Lucidchart, Dokumente,
 * E-Mail-Provider, Analyzer), baulogische Regeln, Benachrichtigungskanäle (vorbereitet),
 * KI-Funktionen (Architektur vorbereitet, bewusst deaktiviert).
 */

import { useState } from 'react'
import { Save, Sparkles, Bell, Database, Info } from 'lucide-react'
import { api } from '../lib/api'
import { useAuth } from '../store/auth'
import { useOrg } from '../store/org'
import { useToast } from '../store/toast'
import { useRoute, navigate } from '../lib/router'
import { Badge, Button, Card, Checkbox, Field, Input, PageHeader, Select, Tabs } from '../components/ui'
import { IntegrationsPanel } from '../components/IntegrationsPanel'
import { RulesPanel } from '../components/RulesPanel'
import { HOLIDAY_REGIONS, holidaysFor } from '../../shared/engine/holidays'
import { formatDate } from '../../shared/engine/dates'
import { AI_TOOL_CONTRACTS } from '../../shared/types'

const AI_FEATURES = ['Plan mit KI erstellen', 'Terminrisiken analysieren', 'Warum ist dieses Projekt verspätet?', '✨ Lösung finden (Szenario-Varianten innerhalb der Regeln)', 'E-Mails interpretieren (KI-Analyzer)', 'Bauzeitenplan optimieren']
type Tab = 'general' | 'integrations' | 'rules'

export function SettingsPage() {
  const { session, can } = useAuth()
  const org = useOrg()
  const toast = useToast()
  const route = useRoute()
  const tab = (route.query.get('tab') as Tab) || 'general'
  const setTab = (t: Tab) => navigate(`/settings${t === 'general' ? '' : `?tab=${t}`}`)
  const [name, setName] = useState(session?.org.name ?? '')
  const [region, setRegion] = useState(org.org.holiday_region)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api.org.update({ name, holiday_region: region })
      await org.reload()
      toast.push('Gespeichert.', 'success')
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const year = new Date().getFullYear()
  const preview = holidaysFor(year, region || org.org.holiday_region)
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <PageHeader title="Einstellungen" subtitle="Organisation, Integrationen, Regeln, Benachrichtigungen, KI" actions={<Tabs value={tab} onChange={setTab} items={[{ value: 'general', label: 'Allgemein' }, { value: 'integrations', label: 'Integrationen' }, { value: 'rules', label: 'Baulogische Regeln' }]} />} />
      {tab === 'integrations' && <IntegrationsPanel />}
      {tab === 'rules' && <RulesPanel />}
      {tab === 'general' && (<>
        <Card title="Organisation">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><Input value={name} disabled={!can('org.manage')} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Mandanten-Kennung" hint="Alle Daten sind strikt an diese Organisation gebunden."><Input value={session?.org.slug ?? ''} disabled /></Field>
            <Field label="Standard-Feiertagsregion" hint="Voreinstellung für neue Projekte; je Projekt änderbar. Gesetzliche Feiertage werden berechnet und in jeder Terminberechnung berücksichtigt.">
              <Select value={region || org.org.holiday_region} disabled={!can('org.manage')} onChange={(e) => setRegion(e.target.value)}>{HOLIDAY_REGIONS.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</Select>
            </Field>
            <div className="text-xs text-ink-soft"><div className="mb-1 font-medium text-ink">Feiertage {year}</div><div className="flex flex-wrap gap-x-3 gap-y-0.5">{preview.map((h) => <span key={h.date}>{formatDate(h.date, 'short')} {h.name}</span>)}</div></div>
          </div>
          {can('org.manage') && <div className="mt-4 flex justify-end"><Button variant="primary" loading={busy} onClick={save}><Save size={15} /> Speichern</Button></div>}
        </Card>
        <Card title={<span className="flex items-center gap-2"><Bell size={15} /> Benachrichtigungen</span>}>
          <p className="mb-3 text-sm text-ink-soft">In-App-Benachrichtigungen sind aktiv (Meilenstein in 3 Tagen, überfällige Vorgänge, Terminabweichung, Baustellen-Updates, Baseline, terminrelevante E-Mails). E-Mail und Push sind in der Architektur vorgesehen (Kanal am Datensatz, Dispatcher-Austauschpunkt) und werden mit einem Provider freigeschaltet.</p>
          <div className="flex flex-wrap gap-4"><Checkbox label="In-App" checked disabled /><Checkbox label="E-Mail (bald)" disabled /><Checkbox label="Push (bald)" disabled /></div>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Sparkles size={15} /> KI-Funktionen <Badge tone="neutral">vorbereitet</Badge></span>}>
          <p className="mb-3 text-sm text-ink-soft">Alle Planungsdaten liegen strukturiert vor (Vorgänge, Abhängigkeiten, Kalender, Feiertage, Baseline, Verzögerungsgründe, Historie, Regeln). Die Schnittstelle <code className="rounded bg-surface-3 px-1 text-xs">AiPlanningContext</code> stellt sie einem späteren KI-Dienst bereit; schreiben darf er ausschließlich als Vorschlag oder Szenario. Es ist bewusst keine Platzhalter-KI aktiv.</p>
          <ul className="grid gap-1.5 sm:grid-cols-2">{AI_FEATURES.map((f) => <li key={f} className="flex items-center gap-2 text-sm text-ink-soft"><span className="h-1.5 w-1.5 rounded-full bg-ink-faint" />{f}</li>)}</ul>
          <div className="mt-3 text-xs text-ink-faint">Werkzeug-Verträge: {AI_TOOL_CONTRACTS.map((t) => t.name).join(', ')} – Scheduling Engine = Wahrheit, Regeln = Grenzen, Mensch entscheidet.</div>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Database size={15} /> Daten</span>}>
          <p className="text-sm text-ink-soft">Exporte (CSV, PDF) finden Sie in den jeweiligen Ansichten: Vorgänge, Soll-Ist, Lookahead, Historie, Berichte. Arbeitskalender: <button type="button" className="text-brand hover:underline" onClick={() => navigate('/calendar')}>Kalender</button>.</p>
          <p className="mt-2 flex items-start gap-2 text-xs text-ink-faint"><Info size={13} className="mt-0.5 shrink-0" /> Angemeldet als {session?.user.name} ({session?.user.email}).</p>
        </Card>
      </>)}
    </div>
  )
}
