/**
 * Planentwurf erzeugen und prüfen – aus einem Lucidchart-Diagramm, einem Dokument
 * (PDF/Word) per KI, aus Jira oder komplett per KI aus einer Beschreibung.
 * Der Entwurf wird immer angezeigt und kann vor der Übernahme bearbeitet werden:
 * Name, Art, Dauer, verantwortliche Person, Reihenfolge, Zeile entfernen.
 */

import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, FileUp, Loader2, Sparkles, Trash2, Wand2, Workflow } from 'lucide-react'
import { Button, Field, Input, Select, Textarea } from './ui'
import { api } from '../lib/api'
import { extractDocumentText, SUPPORTED_DOCUMENT_TYPES } from '../lib/documentText'
import { useOrg } from '../store/org'
import { useToast } from '../store/toast'
import type { ExtractedPlan, ExtractedTask } from '../../shared/integrations/planextract/types'
import type { TaskType } from '../../shared/types'

const TYPE_LABELS: Record<TaskType, string> = { phase: 'Phase', group: 'Bereich', task: 'Aufgabe', milestone: 'Meilenstein' }

/** Fortschritt während die KI den Plan entwirft: Prozent nähert sich asymptotisch 100 % (siehe progressPct-Formel), damit das Warten nicht länger wirkt als es ist. */
function ProgressLine({ pct, count }: { pct: number; count: number }) {
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-brand transition-[width] duration-500 ease-out" style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
      <p className="text-xs text-ink-faint">{count > 0 ? `${count} Vorgänge entworfen … ${pct} %` : 'Text wird analysiert …'}</p>
    </div>
  )
}

export type PlanImportMode = 'lucidchart' | 'document' | 'jira' | 'ai'

/** Ein Block ist eine Phase mit allen darunter liegenden Vorgängen (oder eine einzelne Zeile). */
function blockAt(tasks: ExtractedTask[], index: number): { start: number; end: number } {
  const t = tasks[index]!
  if (t.type !== 'phase' && t.type !== 'group') return { start: index, end: index + 1 }
  let end = index + 1
  while (end < tasks.length && tasks[end]!.parent_key === t.key) end++
  return { start: index, end }
}

export function PlanImportPanel({
  plan,
  onPlan,
  mode: fixedMode,
  hideAi,
  planningKind,
}: {
  plan: ExtractedPlan | null
  onPlan: (plan: ExtractedPlan | null) => void
  mode?: PlanImportMode
  /** KI-aus-Beschreibung hat einen eigenen Einstiegspunkt (Toolbar-Button „KI“) - hier ausblenden. */
  hideAi?: boolean
  planningKind?: string
}) {
  const org = useOrg()
  const toast = useToast()
  const [modeState, setMode] = useState<PlanImportMode>('document')
  const mode = fixedMode ?? modeState
  const [lucidInput, setLucidInput] = useState('')
  const [hint, setHint] = useState('')
  const [brief, setBrief] = useState('')
  const [instruction, setInstruction] = useState('')
  const [jira, setJira] = useState({ base_url: '', email: '', api_token: '', project_key: '', jql: '' })
  const [busy, setBusy] = useState<'' | 'lucid' | 'doc' | 'jira' | 'ai' | 'sort' | 'refine'>('')
  const [fileName, setFileName] = useState('')
  const [draftedCount, setDraftedCount] = useState(0)
  // Es ist vorher nicht bekannt, wie viele Aufgaben am Ende herauskommen - die Prozentzahl
  // nähert sich darum asymptotisch 100 % an (schnell am Anfang, langsamer danach), statt eine
  // falsche Gesamtzahl vorzutäuschen. Fertig wird sie erst durch das tatsächliche Ergebnis.
  const progressPct = Math.round(100 * (1 - 1 / (1 + draftedCount / 8)))

  const people = useMemo(() => org.members.filter((m) => m.user).map((m) => m.user!), [org.members])
  // Aufgabenbereiche als Hinweis mitgeben (Team-Seite) - die KI kann sie als Signal nutzen,
  // muss als responsible aber weiterhin Name oder E-Mail ausgeben (siehe Namensabgleich beim Übernehmen).
  const peopleNames = useMemo(() => org.members.filter((m) => m.user).map((m) => `${m.user!.name} <${m.user!.email}>${m.responsibility_areas.length ? ` (Bereich: ${m.responsibility_areas.join(', ')})` : ''}`), [org.members])

  const run = async (kind: typeof busy, fn: () => Promise<ExtractedPlan>, okMessage: string) => {
    setBusy(kind)
    setDraftedCount(0)
    try {
      onPlan(await fn())
      toast.push(okMessage, 'success')
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy('')
    }
  }

  const loadDocument = async (file: File) => {
    setFileName(file.name)
    await run('doc', async () => {
      const text = await extractDocumentText(file)
      return api.planImport.document({ text, file_name: file.name, hint: hint || undefined }, setDraftedCount)
    }, 'Dokument ausgewertet – bitte prüfen.')
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
        .filter((t) => t.key !== key && t.parent_key !== key)
        .map((t) => ({ ...t, parent_key: t.parent_key === key ? null : t.parent_key, depends_on: (t.depends_on ?? []).filter((d) => d.predecessor_key !== key) })),
    })
  }

  /** Zeile oder ganze Phase samt Vorgängen nach oben/unten verschieben. */
  const move = (index: number, dir: -1 | 1) => {
    if (!plan) return
    const tasks = plan.tasks
    const self = blockAt(tasks, index)
    if (dir === -1) {
      if (self.start === 0) return
      // vorhergehenden Block bestimmen
      let prevStart = self.start - 1
      const prev = tasks[prevStart]!
      if (prev.parent_key && tasks[index]!.parent_key !== prev.parent_key) {
        while (prevStart > 0 && tasks[prevStart]!.parent_key === prev.parent_key) prevStart--
      }
      const before = blockAt(tasks, prevStart)
      const next = [...tasks.slice(0, before.start), ...tasks.slice(self.start, self.end), ...tasks.slice(before.start, before.end), ...tasks.slice(self.end)]
      onPlan({ ...plan, tasks: next })
    } else {
      if (self.end >= tasks.length) return
      const after = blockAt(tasks, self.end)
      const next = [...tasks.slice(0, self.start), ...tasks.slice(after.start, after.end), ...tasks.slice(self.start, self.end), ...tasks.slice(after.end)]
      onPlan({ ...plan, tasks: next })
    }
  }

  const nameByKey = new Map((plan?.tasks ?? []).map((t) => [t.key, t.name]))

  return (
    <div className="space-y-4">
      {!fixedMode && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={mode === 'document' ? 'primary' : 'ghost'} onClick={() => setMode('document')}><Sparkles size={15} /> Dokument mit KI</Button>
          <Button size="sm" variant={mode === 'lucidchart' ? 'primary' : 'ghost'} onClick={() => setMode('lucidchart')}><Workflow size={15} /> Lucidchart</Button>
          <Button size="sm" variant={mode === 'jira' ? 'primary' : 'ghost'} onClick={() => setMode('jira')}>Jira</Button>
          {!hideAi && <Button size="sm" variant={mode === 'ai' ? 'primary' : 'ghost'} onClick={() => setMode('ai')}><Wand2 size={15} /> Aus Beschreibung</Button>}
        </div>
      )}

      {mode === 'lucidchart' && (
        <div className="space-y-2">
          <Field label="Lucidchart-Link oder Dokument-ID">
            <Input value={lucidInput} onChange={(e) => setLucidInput(e.target.value)} placeholder="https://lucid.app/lucidchart/…/edit" />
          </Field>
          <Button size="sm" variant="secondary" disabled={!lucidInput.trim() || !!busy} loading={busy === 'lucid'} onClick={() => void run('lucid', () => api.planImport.lucidchart(lucidInput), 'Diagramm übernommen – bitte prüfen.')}>Diagramm laden</Button>
          <p className="text-xs text-ink-faint">Jeder Rahmen wird eine Phase, die Formen darin werden Vorgänge, Rauten werden Meilensteine und Pfeile geben die Reihenfolge vor. Dauer und Person können im Text stehen: „Entwurf (3 AT) @Edis Sejdinovic“.</p>
        </div>
      )}

      {mode === 'document' && (
        <div className="space-y-2">
          <Field label="Hinweis für die Auswertung (optional)">
            <Textarea rows={2} value={hint} onChange={(e) => setHint(e.target.value)} placeholder="z. B. Nur die Aufgaben der Einführungsphase berücksichtigen" />
          </Field>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2">
            {busy === 'doc' ? <Loader2 size={15} className="animate-spin" /> : <FileUp size={15} />} Dokument wählen (PDF, Word, Text)
            <input type="file" accept={SUPPORTED_DOCUMENT_TYPES} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadDocument(f) }} />
          </label>
          {fileName && <p className="text-xs text-ink-faint">{fileName}</p>}
          {busy === 'doc' && <ProgressLine pct={progressPct} count={draftedCount} />}
          <p className="text-xs text-ink-faint">Die KI liest den Text, gliedert ihn in Phasen und Aufgaben, schätzt Dauern und erkennt Abhängigkeiten sowie genannte Personen.</p>
        </div>
      )}

      {mode === 'jira' && (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Jira-Adresse"><Input value={jira.base_url} onChange={(e) => setJira({ ...jira, base_url: e.target.value })} placeholder="https://baumission.atlassian.net" /></Field>
            <Field label="E-Mail"><Input value={jira.email} onChange={(e) => setJira({ ...jira, email: e.target.value })} placeholder="name@baumission.de" /></Field>
            <Field label="API-Token"><Input type="password" value={jira.api_token} onChange={(e) => setJira({ ...jira, api_token: e.target.value })} placeholder="Token aus dem Atlassian-Konto" /></Field>
            <Field label="Projektschlüssel"><Input value={jira.project_key} onChange={(e) => setJira({ ...jira, project_key: e.target.value })} placeholder="z. B. BM" /></Field>
          </div>
          <Field label="Eigene Abfrage (JQL, optional)">
            <Input value={jira.jql} onChange={(e) => setJira({ ...jira, jql: e.target.value })} placeholder='project = "BM" AND statusCategory != Done ORDER BY created ASC' />
          </Field>
          <Button size="sm" variant="secondary" disabled={!!busy || (!jira.project_key.trim() && !jira.jql.trim())} loading={busy === 'jira'} onClick={() => void run('jira', () => api.planImport.jira(jira), 'Jira-Vorgänge geladen – bitte prüfen.')}>Vorgänge laden</Button>
          <p className="text-xs text-ink-faint">Epics werden zu Phasen, untergeordnete Vorgänge zu Aufgaben, „wird blockiert von“ zu Abhängigkeiten. Aufwandsschätzungen werden in Arbeitstage umgerechnet.</p>
        </div>
      )}

      {mode === 'ai' && (
        <div className="space-y-2">
          <Field label="Beschreibe das Vorhaben">
            <Textarea rows={5} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="z. B. Einführung eines neuen Coaching-Programms in acht Wochen: Konzept, Materialien, Pilotgruppe, Auswertung, Start." />
          </Field>
          <Button size="sm" variant="secondary" disabled={brief.trim().length < 10 || !!busy} loading={busy === 'ai'} onClick={() => void run('ai', () => api.planImport.generate({ brief, kind: planningKind, people: peopleNames }, setDraftedCount), 'Planentwurf erstellt – bitte prüfen.')}>Plan von der KI entwerfen</Button>
          {busy === 'ai' && <ProgressLine pct={progressPct} count={draftedCount} />}
          <p className="text-xs text-ink-faint">Die KI entwirft Phasen, Aufgaben, Dauern und Abhängigkeiten und ordnet Personen aus deinem Team zu.</p>
        </div>
      )}

      {plan && (
        <div className="space-y-3">
          <Field label="Name des Plans">
            <Input value={plan.name} onChange={(e) => onPlan({ ...plan, name: e.target.value })} />
          </Field>

          <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" disabled={!!busy} loading={busy === 'sort'} onClick={() => void run('sort', () => api.planImport.sort(plan), 'Reihenfolge sortiert – bitte prüfen.')}><Wand2 size={14} /> Reihenfolge mit KI sortieren</Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Änderung beschreiben, z. B. „Testphase mit Abnahme ergänzen“" />
              <Button size="sm" variant="secondary" disabled={!instruction.trim() || !!busy} loading={busy === 'refine'} onClick={() => void run('refine', () => api.planImport.refine({ plan, instruction, people: peopleNames }), 'Plan überarbeitet – bitte prüfen.')}><Sparkles size={14} /> Mit KI überarbeiten</Button>
            </div>
          </div>

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
                  <th className="p-2 text-left">Reihenfolge</th>
                  <th className="p-2 text-left">Aufgabe</th>
                  <th className="p-2 text-left">Art</th>
                  <th className="p-2 text-left">Dauer (AT)</th>
                  <th className="p-2 text-left">Verantwortlich</th>
                  <th className="p-2 text-left">Vorgänger</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {plan.tasks.map((t, i) => (
                  <tr key={t.key} className="border-t border-line align-top">
                    <td className="p-2">
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} title="Nach oben"><ArrowUp size={14} /></Button>
                        <Button size="sm" variant="ghost" disabled={i === plan.tasks.length - 1} onClick={() => move(i, 1)} title="Nach unten"><ArrowDown size={14} /></Button>
                      </div>
                    </td>
                    <td className="p-2" style={{ paddingLeft: t.parent_key ? 22 : undefined }}>
                      <Input value={t.name} onChange={(e) => patch(t.key, { name: e.target.value })} />
                    </td>
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
          <p className="text-xs text-ink-faint">{plan.tasks.length} Zeilen. Mit den Pfeilen verschiebst du eine Zeile; bei einer Phase wandern ihre Vorgänge mit. Personen werden über Name oder E-Mail dem Team zugeordnet.</p>
        </div>
      )}
    </div>
  )
}
