/**
 * Gesamten Terminplan mit KI überarbeiten: der aktuelle Plan wird als Entwurf geladen,
 * lässt sich per Anweisung von der KI überarbeiten (oder von Hand anpassen) und landet erst
 * als Szenario - der echte Plan bleibt bis zur Übernahme im Szenario-Vergleich unberührt.
 */

import { useState } from 'react'
import { Button, Modal } from './ui'
import { PlanImportPanel } from './PlanImportPanel'
import { api } from '../lib/api'
import { useProject } from '../store/project'
import { useOrg } from '../store/org'
import { useToast } from '../store/toast'
import { navigate } from '../lib/router'
import { tasksToExtractedPlan, type ExtractedPlan } from '../../shared/integrations/planextract/types'

export function PlanReviseDialog({ onClose }: { onClose: () => void }) {
  const p = useProject()
  const org = useOrg()
  const toast = useToast()
  const [plan, setPlan] = useState<ExtractedPlan | null>(() =>
    tasksToExtractedPlan(p.plan.tasks, p.plan.dependencies, org.members, `${p.bundle?.project.name ?? 'Terminplan'} – überarbeitet`),
  )
  const [busy, setBusy] = useState(false)

  const apply = async () => {
    if (!plan) return
    setBusy(true)
    try {
      const preview = await api.planImport.preview(p.projectId, plan)
      const sc = await api.projects.createScenario(p.projectId, {
        name: plan.name || 'Gesamtüberarbeitung (KI)',
        description: 'Gesamter Terminplan von der KI überarbeitet.',
        origin: 'ai',
        tasks: preview.tasks,
        dependencies: preview.dependencies,
      })
      toast.push(`Szenario „${sc.name}“ angelegt${preview.unmatched.length ? ` – nicht zugeordnete Personen: ${preview.unmatched.join(', ')}` : ''}.`, 'success')
      onClose()
      navigate(`/projects/${p.projectId}/scenarios`)
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
      title="Gesamten Plan überarbeiten"
      width="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={!plan?.tasks.length} onClick={apply}>Als Szenario anlegen</Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-ink-faint">
        Der aktuelle Terminplan ist unten als Entwurf geladen. Beschreiben Sie, was sich ändern soll, und lassen Sie die KI ihn überarbeiten - Zeilen lassen sich danach noch von Hand anpassen.
        Übernommen wird er als Szenario im Vergleich zum echten Plan; der bleibt bis zur Freigabe unberührt.
      </p>
      <PlanImportPanel plan={plan} onPlan={setPlan} mode="revise" planningKind={p.bundle?.project.planning_kind} />
    </Modal>
  )
}
