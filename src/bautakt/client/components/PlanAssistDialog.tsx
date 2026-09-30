/**
 * Aufgaben in ein bestehendes Projekt holen: per KI aus einer Beschreibung, aus einem
 * Dokument (PDF/Word), aus einem Lucidchart-Diagramm oder aus Jira. Der Entwurf lässt
 * sich vorher prüfen, sortieren und mit der KI überarbeiten; erst „Übernehmen“ schreibt.
 * Vor der Übernahme wird gewählt, WO die neuen Vorgänge landen: ans Ende des Terminplans,
 * direkt hinter einem bestehenden Vorgang, oder als Kinder unter einem bestehenden Vorgang
 * (der dadurch zur Phase wird - z. B. „Vorgang 14“, zu dem es neue Detailinformationen gibt).
 */

import { useState } from 'react'
import { Button, Field, Modal, Select } from './ui'
import { PlanImportPanel } from './PlanImportPanel'
import { api } from '../lib/api'
import { useProject } from '../store/project'
import { useToast } from '../store/toast'
import { flattenTree } from '../../shared/engine/operations'
import type { ExtractedPlan } from '../../shared/integrations/planextract/types'

export function PlanAssistDialog({ initialParentId = null, mode, onClose }: { initialParentId?: string | null; mode?: 'ai' | 'import'; onClose: () => void }) {
  const p = useProject()
  const toast = useToast()
  const [plan, setPlan] = useState<ExtractedPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [posMode, setPosMode] = useState<'end' | 'after' | 'under'>(initialParentId ? 'under' : 'end')
  const [posTarget, setPosTarget] = useState(initialParentId ?? '')

  const flat = flattenTree(p.plan.tasks)
  const underTargets = flat.filter((f) => f.task.type !== 'milestone')

  const apply = async () => {
    if (!plan) return
    setBusy(true)
    try {
      const position =
        posMode === 'after' && posTarget
          ? { after_id: posTarget, parent_id: p.plan.tasks.find((t) => t.id === posTarget)?.parent_id ?? null }
          : posMode === 'under' && posTarget
            ? { parent_id: posTarget }
            : {}
      const r = await api.planImport.attach(p.projectId, plan, position)
      toast.push(`${r.tasks_created} Vorgänge übernommen.${r.unmatched.length ? ` Nicht zugeordnete Personen: ${r.unmatched.join(', ')}` : ''}`, 'success')
      await p.reload()
      onClose()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const targetName = (id: string) => flat.find((f) => f.task.id === id)?.task.name ?? ''

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'ai' ? 'Mit KI erweitern' : 'Importieren (Dokument, Lucidchart, Jira)'}
      width="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={!plan?.tasks.length || ((posMode === 'after' || posMode === 'under') && !posTarget)} onClick={apply}>Übernehmen</Button>
        </>
      }
    >
      <Field label="Einfügeposition">
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm"><input type="radio" className="accent-brand" checked={posMode === 'end'} onChange={() => setPosMode('end')} /> ans Ende des Terminplans</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" className="accent-brand" checked={posMode === 'after'} onChange={() => setPosMode('after')} /> direkt nach diesem Vorgang</label>
          {posMode === 'after' && (
            <Select className="mt-1 mb-1" value={posTarget} onChange={(e) => setPosTarget(e.target.value)}>
              <option value="">– Vorgang wählen –</option>
              {flat.map((f) => <option key={f.task.id} value={f.task.id}>{' '.repeat(f.depth * 2)}{f.task.name}</option>)}
            </Select>
          )}
          <label className="flex items-center gap-2 text-sm"><input type="radio" className="accent-brand" checked={posMode === 'under'} onChange={() => setPosMode('under')} /> unter diesem Vorgang (wird zur Phase)</label>
          {posMode === 'under' && (
            <Select className="mt-1" value={posTarget} onChange={(e) => setPosTarget(e.target.value)}>
              <option value="">– Vorgang wählen –</option>
              {underTargets.map((f) => <option key={f.task.id} value={f.task.id}>{' '.repeat(f.depth * 2)}{f.task.name}</option>)}
            </Select>
          )}
        </div>
      </Field>
      <div className="mt-4">
        <PlanImportPanel plan={plan} onPlan={setPlan} mode={mode === 'ai' ? 'ai' : undefined} hideAi={mode === 'import'} projectId={p.projectId} />
      </div>
      <p className="mt-3 text-xs text-ink-faint">
        {posMode === 'under' && posTarget
          ? `„${targetName(posTarget)}“ wird zur Phase, die neuen Vorgänge werden darunter eingeordnet.`
          : posMode === 'after' && posTarget
            ? `Die neuen Vorgänge werden direkt hinter „${targetName(posTarget)}“ eingefügt.`
            : 'Die Vorgänge werden ans Ende des Terminplans angehängt.'}{' '}
        Termine berechnet das System aus Dauern, Abhängigkeiten und Feiertagen.
      </p>
    </Modal>
  )
}
