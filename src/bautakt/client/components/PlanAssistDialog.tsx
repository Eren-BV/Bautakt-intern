/**
 * Aufgaben in ein bestehendes Projekt holen: per KI aus einer Beschreibung, aus einem
 * Dokument (PDF/Word), aus einem Lucidchart-Diagramm oder aus Jira. Der Entwurf lässt
 * sich vorher prüfen, sortieren und mit der KI überarbeiten; erst „Übernehmen“ schreibt.
 */

import { useState } from 'react'
import { Button, Modal } from './ui'
import { PlanImportPanel } from './PlanImportPanel'
import { api } from '../lib/api'
import { useProject } from '../store/project'
import { useToast } from '../store/toast'
import type { ExtractedPlan } from '../../shared/integrations/planextract/types'

export function PlanAssistDialog({ onClose }: { onClose: () => void }) {
  const p = useProject()
  const toast = useToast()
  const [plan, setPlan] = useState<ExtractedPlan | null>(null)
  const [busy, setBusy] = useState(false)

  const apply = async () => {
    if (!plan) return
    setBusy(true)
    try {
      const r = await api.planImport.attach(p.projectId, plan)
      toast.push(`${r.tasks_created} Vorgänge übernommen.${r.unmatched.length ? ` Nicht zugeordnete Personen: ${r.unmatched.join(', ')}` : ''}`, 'success')
      await p.reload()
      onClose()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Aufgaben ergänzen (KI, Dokument, Lucidchart, Jira)"
      width="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={!plan?.tasks.length} onClick={apply}>Übernehmen</Button>
        </>
      }
    >
      <PlanImportPanel plan={plan} onPlan={setPlan} />
      <p className="mt-3 text-xs text-ink-faint">Die Vorgänge werden an den bestehenden Plan angehängt. Termine berechnet das System aus Dauern, Abhängigkeiten und Feiertagen.</p>
    </Modal>
  )
}
