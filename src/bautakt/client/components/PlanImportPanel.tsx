/**
 * Planentwurf importieren und prüfen: aus einem Lucidchart-Diagramm oder aus einem
 * Dokument (PDF/Word) per KI-Analyse. Der Entwurf wird immer angezeigt und kann vor der
 * Übernahme bearbeitet werden (Name, Art, Dauer, verantwortliche Person, Zeile entfernen).
 */

import { useMemo, useState } from 'react'
import { AlertTriangle, FileUp, Loader2, Sparkles, Trash2, Workflow } from 'lucide-react'
import { Button, Field, Input, Select, Textarea } from './ui'
import { api } from '../lib/api'
import { extractDocumentText, SUPPORTED_DOCUMENT_TYPES } from '../lib/documentText'
import { useOrg } from '../store/org'
import { useToast } from '../store/toast'
import type { ExtractedPlan, ExtractedTask } from '../../shared/integrations/planextract/types'
import type { TaskType } from '../../shared/types'

const TYPE_LABELS: Record<TaskType, string> = { phase: 'Phase', group: 'Bereich', task: 'Aufgabe', milestone: 'Meilenstein' }

export function PlanImportPanel({ plan, onPlan }: { plan: ExtractedPlan | null; onPlan: (plan: ExtractedPlan | null) => void }) {
  const org = useOrg()
  const toast = useToast()
  const [mode, setMode] = useState<'lucidchart' | 'document'>('lucidchart')
  const [lucidInput, setLucidInput] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState<'' | 'lucid' | 'doc'>('')
  const [fileName, setFileName] = useState('')

  const people = useMemo(() => org.members.filter((m) => m.user).map((m) => m.user!), [org.members])

  const loadLucid = async () => {
    setBusy('lucid')
    try {
      onPlan(await api.planImport.lucidchart(lucidInput))
      toast.push('Diagramm übernommen – bitte prüfen.', 'success')
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy('')
    }
  }

  const loadDocument = async (file: File) => {
    setBusy('doc')
    setFileName(file.name)
    try {
      const text = await extractDocumentText(file)
      onPlan(await api.planImport.document({ text, file_name: file.name, hint: hint || undefined }))
      toast.push('Dokument ausgewertet – bitte prüfen.', 'success')
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy('')
    }
  }

  const patch = (key: string, fields: Partial<ExtractedTask>) => {
    if (!plan) return
    onPlan({ ...plan, tasks: plan.tasks.map((t) => (t.key === key ? { ...t, ...fields } : t)) })
  }
  const remove = (key: string) => {
    if (!plan) return
    onPlan({
      ...plan,
      tasks: plan.tasks
        .filter((t) => t.key !== key)
        .map((t) => ({ ...t, parent_key: t.parent_key === key ? null : t.parent_key, depends_on: (t.depends_on ?? []).filter((d) => d.predecessor_key !== key) })),
    })
  }

  const nameByKey = new Map((plan?.tasks ?? []).map((t) => [t.key, t.name]))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={mode === 'lucidchart' ? 'primary' : 'ghost'} onClick={() => setMode('lucidchart')}><Workflow size={15} /> Lucidchart</Button>
        <Button size="sm" variant={mode === 'document' ? 'primary' : 'ghost'} onClick={() => setMode('document')}><Sparkles size={15} /> Dokument mit KI</Button>
      </div>

      {mode === 'lucidchart' ? (
        <div className="space-y-2">
          <Field label="Lucidchart-Link oder Dokument-ID">
            <Input value={lucidInput} onChange={(e) => setLucidInput(e.target.value)} placeholder="https://lucid.app/lucidchart/…/edit" />
          </Field>
          <Button size="sm" variant="secondary" disabled={!lucidInput.trim() || busy === 'lucid'} loading={busy === 'lucid'} onClick={loadLucid}>Diagramm laden</Button>
          <p className="text-xs text-ink-faint">Formen werden zu Aufgaben, Rauten zu Meilensteinen, Pfeile zu Abhängigkeiten. Dauer und Person können im Text stehen: „Entwurf (3 AT) @Jan Pfeiffer“.</p>
        </div>
      ) : (
        <div className="space-y-2">
          <Field label="Hinweis für die Auswertung (optional)">
            <Textarea rows={2} value={hint} onChange={(e) => setHint(e.target.value)} placeholder="z. B. Nur die Aufgaben des Innenausbaus berücksichtigen" />
          </Field>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2">
            {busy === 'doc' ? <Loader2 size={15} className="animate-spin" /> : <FileUp size={15} />} Dokument wählen (PDF, Word, Text)
            <input type="file" accept={SUPPORTED_DOCUMENT_TYPES} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadDocument(f) }} />
          </label>
          {fileName && <p className="text-xs text-ink-faint">{fileName}</p>}
          <p className="text-xs text-ink-faint">Die KI liest den Text, gliedert ihn in Phasen und Aufgaben, schätzt Dauern und erkennt Abhängigkeiten sowie genannte Personen.</p>
        </div>
      )}

      {plan && (
        <div className="space-y-3">
          <Field label="Name des Plans">
            <Input value={plan.name} onChange={(e) => onPlan({ ...plan, name: e.target.value })} />
          </Field>
          {!!plan.warnings?.length && (
            <div className="flex gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs text-ink-soft">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
              <ul className="list-disc space-y-1 pl-4">{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs text-ink-faint">
                <tr>
                  <th className="p-2 text-left">Aufgabe</th>
                  <th className="p-2 text-left">Art</th>
                  <th className="p-2 text-left">Dauer (AT)</th>
                  <th className="p-2 text-left">Verantwortlich</th>
                  <th className="p-2 text-left">Vorgänger</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {plan.tasks.map((t) => (
                  <tr key={t.key} className="border-t border-line align-top">
                    <td className="p-2"><Input value={t.name} onChange={(e) => patch(t.key, { name: e.target.value })} /></td>
                    <td className="p-2">
                      <Select value={t.type} onChange={(e) => patch(t.key, { type: e.target.value as TaskType })}>
                        {(Object.keys(TYPE_LABELS) as TaskType[]).map((k) => <option key={k} value={k}>{TYPE_LABELS[k]}</option>)}
                      </Select>
                    </td>
                    <td className="p-2">
                      <Input type="number" min={0} value={t.type === 'milestone' ? 0 : (t.duration ?? 1)} disabled={t.type === 'milestone'} onChange={(e) => patch(t.key, { duration: Math.max(0, Number(e.target.value) || 0) })} />
                    </td>
                    <td className="p-2">
                      <Select value={t.responsible ?? ''} onChange={(e) => patch(t.key, { responsible: e.target.value || null })}>
                        <option value="">– keine –</option>
                        {t.responsible && !people.some((u) => u.name === t.responsible || u.email === t.responsible) && <option value={t.responsible}>{t.responsible} (aus Import)</option>}
                        {people.map((u) => <option key={u.id} value={u.email}>{u.name}</option>)}
                      </Select>
                    </td>
                    <td className="p-2 text-xs text-ink-soft">{(t.depends_on ?? []).map((d) => nameByKey.get(d.predecessor_key)).filter(Boolean).join(', ') || '–'}</td>
                    <td className="p-2"><Button size="sm" variant="ghost" onClick={() => remove(t.key)}><Trash2 size={14} /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-faint">{plan.tasks.length} Zeilen. Personen werden über Name oder E-Mail dem Team zugeordnet; unbekannte Namen bleiben als Freitext stehen.</p>
        </div>
      )}
    </div>
  )
}
