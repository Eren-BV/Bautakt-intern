/**
 * Integrationen: Status der Provider (BuildFlow-Export/-API, E-Mail: manuell, Microsoft 365,
 * Gmail, IMAP) und des Analyzers. Ehrlich: was vorbereitet, aber nicht verbunden ist, wird
 * genau so angezeigt – keine Attrappen.
 */

import { useEffect, useState } from 'react'
import { Workflow, Mail, Plug, Sparkles } from 'lucide-react'
import { api } from '../lib/api'
import { Badge, Card, Spinner } from './ui'

type Status = Awaited<ReturnType<typeof api.integrations.status>>

const TONE: Record<Status['providers'][number]['status'], 'ok' | 'brand' | 'neutral'> = { connected: 'ok', available: 'brand', not_connected: 'neutral' }
const LABEL: Record<Status['providers'][number]['status'], string> = { connected: 'verbunden', available: 'verfügbar', not_connected: 'nicht verbunden' }

export function IntegrationsPanel() {
  const [data, setData] = useState<Status | null>(null)
  const [imp, setImp] = useState<{ lucidchart: boolean; ai: boolean } | null>(null)
  useEffect(() => {
    api.integrations.status().then(setData).catch(() => setData(null))
    api.planImport.status().then((s) => setImp({ lucidchart: !!s.lucidchart, ai: !!s.ai })).catch(() => setImp(null))
  }, [])
  if (!data) return <Spinner />
  const group = (kind: 'buildflow' | 'email') => data.providers.filter((p) => p.kind === kind)
  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><Workflow size={15} /> Lucidchart & Dokumente</span>} padded={false}>
        <p className="border-b border-line px-4 py-3 text-sm text-ink-soft">Projekte entstehen aus einem Lucidchart-Diagramm (Formen → Aufgaben, Pfeile → Abhängigkeiten, Rauten → Meilensteine) oder aus einem Dokument: PDF und Word werden per KI ausgewertet, Phasen, Aufgaben, Dauern, Verantwortliche und Reihenfolgen erkannt. Vor der Übernahme wird immer ein Entwurf zur Prüfung angezeigt.</p>
        <ul className="divide-y divide-line">
          <li className="flex items-start gap-3 px-4 py-2.5"><Plug size={15} className="mt-0.5 shrink-0 text-ink-faint" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">Lucidchart</span><Badge tone={imp?.lucidchart ? 'ok' : 'neutral'}>{imp?.lucidchart ? 'verbunden' : 'Schlüssel fehlt'}</Badge></div><div className="text-xs text-ink-soft">Diagramm-Link oder Dokument-ID einfügen – die Struktur wird direkt geladen.</div></div></li>
          <li className="flex items-start gap-3 px-4 py-2.5"><Plug size={15} className="mt-0.5 shrink-0 text-ink-faint" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">KI-Dokumentenanalyse</span><Badge tone={imp?.ai ? 'ok' : 'neutral'}>{imp?.ai ? 'aktiv' : 'nicht verfügbar'}</Badge></div><div className="text-xs text-ink-soft">PDF, Word, Text – Aufgaben, Dauern, Personen und Abhängigkeiten werden vorgeschlagen.</div></div></li>
        </ul>
        <p className="px-4 py-3 text-xs text-ink-faint">Nutzung: Projekt anlegen → Schritt „Aufgaben & Zeitplan“ → „Aus Dokument oder Lucidchart“.</p>
      </Card>
      <Card title={<span className="flex items-center gap-2"><Mail size={15} /> E-Mail-Eingang</span>} padded={false}>
        <p className="border-b border-line px-4 py-3 text-sm text-ink-soft">Pipeline: Provider → Ingestion → Absender-Zuordnung (Firma/Kontakt) → Projekt-Zuordnung → Klassifikation → Vorgangs-Zuordnung → strukturierter Vorschlag → Auswirkung (Scheduling Engine) → Prüfung durch Projektleiter → optionale Übernahme. Keine Provider-Logik in der Terminlogik.</p>
        <ul className="divide-y divide-line">{group('email').map((p) => <Provider key={p.provider} p={p} />)}</ul>
        <div className="flex items-start gap-2 border-t border-line px-4 py-3 text-sm"><Sparkles size={15} className="mt-0.5 shrink-0 text-ink-faint" /><div><div className="flex items-center gap-2"><b>Analyse</b><Badge tone="brand">aktiv: regelbasiert</Badge><Badge tone="neutral">KI: vorbereitet</Badge></div><div className="text-xs text-ink-soft">{data.analyzer.note} Harte Regel: Die Analyse darf lesen, klassifizieren, zuordnen, Termine erkennen und vorschlagen – den Masterplan verändert nur der Projektleiter über „Übernehmen“.</div></div></div>
      </Card>
    </div>
  )
}

function Provider({ p }: { p: Status['providers'][number] }) {
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <Plug size={15} className="mt-0.5 shrink-0 text-ink-faint" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{p.name}</span><Badge tone={TONE[p.status]}>{LABEL[p.status]}</Badge></div>
        <div className="text-xs text-ink-soft">{p.note}</div>
      </div>
    </li>
  )
}
