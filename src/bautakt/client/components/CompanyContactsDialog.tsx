/**
 * Ansprechpartner einer Firma: Name, Rolle (Disposition, Buchhaltung, Bauleitung …),
 * E-Mail, Telefon, relevante Projekte. Die E-Mail-Adressen sind die Grundlage für die
 * Absender-Zuordnung eingehender E-Mails (wer schreibt?).
 */

import { useEffect, useState } from 'react'
import { Plus, Trash2, Pencil, Mail, Phone } from 'lucide-react'
import { api } from '../lib/api'
import { useOrg } from '../store/org'
import { useAuth } from '../store/auth'
import { useToast } from '../store/toast'
import { Badge, Button, Checkbox, Field, IconButton, Input, Modal } from './ui'
import type { Company, Contact } from '../../shared/types'

const ROLES = ['Inhaber / Bauleitung', 'Disposition', 'Buchhaltung', 'Projektleitung', 'Polier', 'Vertrieb', 'Sonstiges']

export function CompanyContactsDialog({ company, onClose }: { company: Company; onClose: () => void }) {
  const org = useOrg()
  const { can } = useAuth()
  const toast = useToast()
  const ro = !can('resources.manage')
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [edit, setEdit] = useState<Partial<Contact> | null>(null)
  const contacts = org.contacts.filter((c) => c.company_id === company.id)
  useEffect(() => {
    api.projects.list().then((r) => setProjects(r.summaries.filter((x) => x.project.state !== 'completed').map((x) => ({ id: x.project.id, name: x.project.name })))).catch(() => {})
  }, [])
  const save = async () => {
    if (!edit?.name?.trim()) return
    try {
      const { id, ...data } = edit
      if (id) await api.contacts.update(id, data)
      else await api.contacts.create({ ...data, company_id: company.id })
      await org.reload()
      setEdit(null)
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const remove = async (c: Contact) => {
    if (!confirm(`Ansprechpartner „${c.name}“ löschen?`)) return
    await api.contacts.remove(c.id)
    await org.reload()
  }
  return (
    <Modal open onClose={onClose} title={`${company.name} – Ansprechpartner`} width="lg" footer={<Button variant="ghost" onClick={onClose}>Schließen</Button>}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
          <span>Kategorien: {company.trade_ids.map((id) => org.tradeName(id)).join(', ') || '–'}</span>
          {company.email && <span className="inline-flex items-center gap-1"><Mail size={12} /> {company.email} (allgemein)</span>}
          {company.phone && <span className="inline-flex items-center gap-1"><Phone size={12} /> {company.phone}</span>}
          {company.address && <span>{company.address}</span>}
        </div>
        <table className="data-table w-full text-sm">
          <thead><tr><th>Name</th><th>Rolle</th><th>E-Mail</th><th>Telefon</th><th>Projekte</th><th /></tr></thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id}>
                <td className="font-medium">{c.name}</td>
                <td className="text-xs">{c.role}</td>
                <td className="text-xs">{c.email}</td>
                <td className="text-xs">{c.phone}</td>
                <td className="text-xs">{c.project_ids.length ? c.project_ids.map((id) => <Badge key={id} tone="neutral" className="mr-1">{projects.find((p) => p.id === id)?.name ?? '…'}</Badge>) : <span className="text-ink-faint">alle</span>}</td>
                <td className="text-right whitespace-nowrap">{!ro && <><IconButton title="Bearbeiten" onClick={() => setEdit(c)}><Pencil size={14} /></IconButton><IconButton title="Löschen" onClick={() => remove(c)}><Trash2 size={14} /></IconButton></>}</td>
              </tr>
            ))}
            {contacts.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-ink-faint">Noch keine Ansprechpartner – E-Mails dieser Firma werden nur über die allgemeine Adresse/Domain zugeordnet.</td></tr>}
          </tbody>
        </table>
        {!ro && !edit && <Button size="sm" variant="primary" onClick={() => setEdit({ name: '', role: ROLES[0], email: '', phone: '', notes: '', project_ids: [] })}><Plus size={14} /> Ansprechpartner</Button>}
        {edit && (
          <div className="space-y-3 rounded-lg border border-line bg-surface-2 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" required><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></Field>
              <Field label="Rolle"><Input list="contact-roles" value={edit.role ?? ''} onChange={(e) => setEdit({ ...edit, role: e.target.value })} /><datalist id="contact-roles">{ROLES.map((r) => <option key={r} value={r} />)}</datalist></Field>
              <Field label="E-Mail"><Input type="email" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
              <Field label="Telefon"><Input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            </div>
            <Field label="Relevante Projekte" hint="Leer = alle; hilft bei der Projekt-Zuordnung eingehender E-Mails">
              <div className="flex flex-wrap gap-3">{projects.map((p) => <Checkbox key={p.id} label={p.name} checked={(edit.project_ids ?? []).includes(p.id)} onChange={(e) => setEdit({ ...edit, project_ids: e.target.checked ? [...(edit.project_ids ?? []), p.id] : (edit.project_ids ?? []).filter((x) => x !== p.id) })} />)}</div>
            </Field>
            <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Abbrechen</Button><Button size="sm" variant="primary" disabled={!edit.name?.trim()} onClick={save}>Speichern</Button></div>
          </div>
        )}
      </div>
    </Modal>
  )
}
