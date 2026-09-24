/**
 * BuildFlow je Projekt: verknüpfte Prozesse (Stand, Version, letzter Abgleich), Prozess
 * in bestehendes Projekt übernehmen, neuen Export einspielen → Diff-Vorschau (hinzugefügt /
 * verändert / entfernt) → „Änderungen prüfen“ erzeugt einen Change Proposal. Nie ungefragt.
 */

import { useEffect, useState } from 'react'
import { Workflow, Upload, RefreshCw, Trash2, AlertTriangle, ArrowRight } from 'lucide-react'
import { api, type ProcessLinkInfo } from '../lib/api'
import { useProject } from '../store/project'
import { useAuth } from '../store/auth'
import { useToast } from '../store/toast'
import { navigate } from '../lib/router'
import { Badge, Button, Card, Modal, Textarea } from './ui'
import { formatDateTime } from '../../shared/engine/dates'
import { parseBuildFlowExport } from '../../shared/integrations/buildflow/types'

type Diff = Awaited<ReturnType<typeof api.buildflow.diff>>

export function BuildFlowPanel() {
  const p = useProject()
  const { can } = useAuth()
  const toast = useToast()
  const [links, setLinks] = useState<ProcessLinkInfo[] | null>(null)
  const [dialog, setDialog] = useState<{ mode: 'attach' } | { mode: 'sync'; link: ProcessLinkInfo } | null>(null)
  const [text, setText] = useState('')
  const [diff, setDiff] = useState<Diff | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => api.buildflow.links(p.projectId).then(setLinks).catch(() => setLinks([]))
  useEffect(() => {
    void load()
  }, [p.projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = (() => {
    try { return text.trim() ? parseBuildFlowExport(JSON.parse(text)) : [] } catch { return [] }
  })()
  const preview = async () => {
    if (!dialog || dialog.mode !== 'sync' || !parsed.length) return
    try {
      setDiff(await api.buildflow.diff(p.projectId, dialog.link.id, parsed))
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const run = async () => {
    if (!dialog) return
    setBusy(true)
    try {
      if (dialog.mode === 'attach') {
        const r = await api.buildflow.attach(p.projectId, parsed)
        toast.push(`${r.processes.join(', ')}: ${r.tasks_created} Vorgänge übernommen.`, 'success')
        await p.reload()
      } else {
        const r = await api.buildflow.sync(p.projectId, dialog.link.id, parsed)
        if (r.changed) {
          toast.push('Änderungen als Vorschlag angelegt – bitte prüfen und entscheiden.', 'success')
          navigate(`/projects/${p.projectId}/proposals`)
        } else toast.push(r.message ?? 'Keine Änderungen.', 'info')
      }
      setDialog(null)
      setText('')
      setDiff(null)
      await load()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const loadSample = async (changed: boolean) => {
    const s = await api.buildflow.sample()
    setText(JSON.stringify([changed ? s.changed : s.current], null, 2))
    setDiff(null)
  }
  const ro = !can('plan.edit')

  return (
    <>
      <Card title={<span className="flex items-center gap-2"><Workflow size={15} /> BuildFlow</span>} actions={!ro && <Button size="sm" onClick={() => { setDialog({ mode: 'attach' }); setText(''); setDiff(null) }}><Upload size={13} /> Prozess übernehmen</Button>}>
        {!links ? <p className="text-sm text-ink-faint">wird geladen …</p> : links.length === 0 ? (
          <p className="text-sm text-ink-soft">Kein BuildFlow-Prozess verknüpft. „Prozess übernehmen“ liest den JSON-Export aus BuildFlow (Prozesse → Exportieren) und legt daraus eine Phase mit Schritten, Abhängigkeiten und Voraussetzungen an – inklusive Verknüpfung für den späteren Abgleich.</p>
        ) : (
          <ul className="divide-y divide-line">
            {links.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{l.process_name}</span><Badge tone="neutral">Version {l.process_version}</Badge>{l.open_proposal_id && <Badge tone="warn">Abgleich offen</Badge>}</div>
                  <div className="text-xs text-ink-faint">{l.node_count} Schritte · {l.mapped_tasks} zugeordnete Vorgänge · verknüpft {formatDateTime(l.created_at)}{l.last_synced_at ? ` · letzter Abgleich ${formatDateTime(l.last_synced_at)}` : ''}</div>
                </div>
                {l.open_proposal_id ? (
                  <Button size="sm" variant="primary" onClick={() => navigate(`/projects/${p.projectId}/proposals`)}>Änderungen prüfen <ArrowRight size={13} /></Button>
                ) : !ro && (
                  <Button size="sm" onClick={() => { setDialog({ mode: 'sync', link: l }); setText(''); setDiff(null) }}><RefreshCw size={13} /> Neuen Stand abgleichen</Button>
                )}
                {!ro && <Button size="sm" variant="ghost" className="text-danger" onClick={async () => { if (confirm('Verknüpfung lösen? Die Vorgänge bleiben erhalten, ein späterer Abgleich ist dann nicht mehr möglich.')) { await api.buildflow.unlink(p.projectId, l.id); await load() } }}><Trash2 size={13} /></Button>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-ink-faint">Prinzip: BuildFlow beschreibt <i>wie</i>, BauTakt <i>wann</i>. Ändert sich der Prozess, entsteht ein Änderungsvorschlag mit Auswirkung – der laufende Terminplan wird nie ungefragt synchronisiert.</p>
      </Card>

      <Modal open={!!dialog} onClose={() => setDialog(null)} title={dialog?.mode === 'attach' ? 'BuildFlow-Prozess übernehmen' : `Abgleich: ${dialog?.mode === 'sync' ? dialog.link.process_name : ''}`} width="xl" footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Abbrechen</Button>{dialog?.mode === 'sync' && <Button disabled={!parsed.length} onClick={preview}>Vorschau</Button>}<Button variant="primary" loading={busy} disabled={!parsed.length} onClick={run}>{dialog?.mode === 'attach' ? 'Als neue Phase übernehmen' : 'Änderungen prüfen (Vorschlag erzeugen)'}</Button></>}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2"><Upload size={15} /> prozesse.json wählen<input type="file" accept=".json,application/json" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setText(await f.text()); setDiff(null) } }} /></label>
            <span className="text-xs text-ink-faint">oder einfügen:</span>
            <Button size="sm" variant="ghost" onClick={() => loadSample(dialog?.mode === 'sync')}>Beispiel laden{dialog?.mode === 'sync' ? ' (geänderte Version 1.3)' : ''}</Button>
          </div>
          <Textarea rows={5} value={text} onChange={(e) => { setText(e.target.value); setDiff(null) }} placeholder="BuildFlow → Prozesse → Exportieren → Inhalt der prozesse.json" className="font-mono text-xs" />
          {text && parsed.length === 0 && <p className="text-xs text-danger">Kein gültiger BuildFlow-Prozess erkannt.</p>}
          {parsed.length > 0 && <p className="text-xs text-ink-soft">Erkannt: {parsed.map((x) => `${x.name} (${x.templateVersion ?? x.version}, ${x.nodes.length} Schritte)`).join(', ')}</p>}
          {diff && (
            <div className="rounded-lg border border-line bg-surface-2 p-3 text-sm">
              {!diff.same_process && <p className="mb-2 flex items-center gap-1 text-xs text-warn"><AlertTriangle size={13} /> Der Export enthält den verknüpften Prozess nicht – Vergleich mit „{diff.process.name}“.</p>}
              <div className="mb-2 flex flex-wrap gap-2"><Badge tone="ok">{diff.counts.added} neue Schritte</Badge><Badge tone="brand">{diff.counts.changed} geändert</Badge><Badge tone="danger">{diff.counts.removed} entfernt</Badge><Badge tone="neutral">{diff.counts.edges_added + diff.counts.edges_removed} Verbindungen</Badge></div>
              {diff.summary.length === 0 ? <p className="text-ink-soft">Keine terminrelevanten Änderungen.</p> : <ul className="list-disc pl-5 text-xs text-ink-soft">{diff.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>}
              <p className="mt-2 text-[11px] text-ink-faint">Die Auswirkungen auf Termine sehen Sie im Änderungsvorschlag – dort entscheiden Sie über Übernahme, Ablehnung oder Bearbeitung als Szenario.</p>
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}
