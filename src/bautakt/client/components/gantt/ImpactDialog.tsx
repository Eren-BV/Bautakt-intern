/**
 * "Diese Änderung beeinflusst N weitere Vorgänge." - Kaskade oder nur dieser Vorgang,
 * optional mit Änderungsgrund für die Historie.
 */

import { useState } from 'react'
import { ArrowRight, CalendarOff } from 'lucide-react'
import type { ImpactAnalysis } from '../../../shared/engine/operations'
import { Button, Delta, Field, Input, Modal } from '../ui'
import { formatDate } from '../../../shared/engine/dates'

export interface PendingChange {
  description: string
  impact: ImpactAnalysis
  /** Hinweise der Kalender-Engine (Feiertage/Schließtage im Zeitraum) */
  notes?: string[]
  commit(cascade: boolean, reason: string): void
}

export function ImpactDialog({ pending, onClose }: { pending: PendingChange | null; onClose: () => void }) {
  const [reason, setReason] = useState('')
  if (!pending) return null
  const { impact } = pending
  const n = impact.affected.length
  return (
    <Modal
      open
      onClose={onClose}
      title={n > 0 ? `Diese Änderung beeinflusst ${n} weitere${n === 1 ? 'n' : ''} Vorgang${n === 1 ? '' : 'e'}` : 'Änderung übernehmen'}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          {n > 0 && (
            <Button
              variant="secondary"
              onClick={() => {
                pending.commit(false, reason)
                onClose()
              }}
            >
              Nur diesen Vorgang ändern
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => {
              pending.commit(true, reason)
              onClose()
            }}
          >
            {n > 0 ? 'Abhängige Vorgänge verschieben' : 'Übernehmen'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-soft">{pending.description}</p>
      {pending.notes && pending.notes.length > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn"><CalendarOff size={14} className="mt-0.5 shrink-0" /><div>{pending.notes.map((t, i) => <p key={i}>{t}</p>)}</div></div>
      )}
      <div className="mt-3 flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
        <span className="text-ink-soft">Projektende</span>
        <span className="font-medium">{formatDate(impact.oldProjectEnd)}</span>
        <ArrowRight size={14} className="text-ink-faint" />
        <span className="font-medium">{formatDate(impact.newProjectEnd)}</span>
        <span className="ml-auto">
          <Delta days={impact.projectEndShiftDays} suffix=" Tage" />
        </span>
      </div>
      {n > 0 && (
        <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-line">
          <table className="data-table w-full text-xs">
            <thead>
              <tr>
                <th>Vorgang</th>
                <th>Bisher</th>
                <th>Neu</th>
                <th className="text-right">Verschiebung</th>
              </tr>
            </thead>
            <tbody>
              {impact.affected.map((a) => (
                <tr key={a.id}>
                  <td className="font-medium">{a.name}</td>
                  <td className="whitespace-nowrap text-ink-soft">
                    {formatDate(a.oldStart, 'short')} – {formatDate(a.oldEnd, 'short')}
                  </td>
                  <td className="whitespace-nowrap">
                    {formatDate(a.newStart, 'short')} – {formatDate(a.newEnd, 'short')}
                  </td>
                  <td className="text-right">
                    <Delta days={a.shiftDays} suffix=" T" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {n > 0 && <p className="mt-2 text-xs text-ink-faint">„Nur diesen Vorgang ändern“ fixiert die betroffenen Nachfolger auf ihren bisherigen Terminen (manuelle Planung) und markiert verletzte Abhängigkeiten.</p>}
      <Field label="Änderungsgrund (für die Historie)" className="mt-4">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="z. B. Lieferverzug Fenster, Wetter, Bauherrenwunsch …" />
      </Field>
    </Modal>
  )
}
