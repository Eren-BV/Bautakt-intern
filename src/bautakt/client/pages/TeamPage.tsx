/**
 * Team: Mitglieder der Organisation und ihre Rollen; Einladen (Konto anlegen),
 * Rolle ändern, entfernen. Rechte-Matrix zur Orientierung.
 */

import { useState, type FormEvent } from 'react'
import { Plus, Trash2, ShieldCheck } from 'lucide-react'
import { api } from '../lib/api'
import { useOrg } from '../store/org'
import { useAuth } from '../store/auth'
import { useToast } from '../store/toast'
import { Badge, Button, Card, Field, IconButton, Input, Modal, PageHeader, Select } from '../components/ui'
import { ROLES, ROLE_LABELS, can as canRole, type Capability } from '../../shared/permissions'
import type { OrgRole } from '../../shared/types'

const CAPS: { cap: Capability; label: string }[] = [
  { cap: 'project.create', label: 'Projekte anlegen' },
  { cap: 'plan.edit', label: 'Terminplan bearbeiten' },
  { cap: 'baseline.save', label: 'Baseline speichern' },
  { cap: 'site.update', label: 'Vor-Ort-Update' },
  { cap: 'templates.manage', label: 'Vorlagen' },
  { cap: 'resources.manage', label: 'Firmen & Ressourcen' },
  { cap: 'calendar.manage', label: 'Kalender' },
  { cap: 'reports.view', label: 'Berichte' },
  { cap: 'org.members.manage', label: 'Team verwalten' },
  { cap: 'project.delete', label: 'Projekte löschen' },
]

export function TeamPage() {
  const org = useOrg()
  const { session, can } = useAuth()
  const toast = useToast()
  const [invite, setInvite] = useState<{ name: string; email: string; role: OrgRole; password: string } | null>(null)
  const ro = !can('org.members.manage')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!invite) return
    try {
      await api.org.addMember(invite)
      await org.reload()
      toast.push('Mitglied hinzugefügt.', 'success')
      setInvite(null)
    } catch (err) {
      toast.push((err as Error).message, 'error')
    }
  }

  return (
    <div className="mx-auto max-w-[1100px] space-y-6 p-4 sm:p-6">
      <PageHeader title="Team" subtitle={`${org.members.length} Mitglieder in ${session?.org.name}`} actions={!ro && <Button variant="primary" onClick={() => setInvite({ name: '', email: '', role: 'site_manager', password: '' })}><Plus size={15} /> Mitglied hinzufügen</Button>} />
      <Card padded={false}>
        <table className="data-table w-full text-sm">
          <thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th /></tr></thead>
          <tbody>
            {org.members.map((m) => (
              <tr key={m.user_id}>
                <td className="font-medium">{m.user?.name}{m.user_id === session?.user.id && <Badge tone="brand" className="ml-2">Sie</Badge>}</td>
                <td className="text-ink-soft">{m.user?.email}</td>
                <td>
                  {ro || m.user_id === session?.user.id || (m.role === 'owner' && session?.role !== 'owner') ? <Badge tone={m.role === 'owner' ? 'brand' : 'neutral'}>{ROLE_LABELS[m.role]}</Badge> : (
                    <Select value={m.role} className="h-8 w-44 text-xs" onChange={async (e) => { try { await api.org.updateMember(m.user_id, e.target.value); await org.reload() } catch (err) { toast.push((err as Error).message, 'error') } }}>
                      {ROLES.filter((r) => r !== 'owner' || session?.role === 'owner').map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </Select>
                  )}
                </td>
                <td className="text-right">{!ro && m.user_id !== session?.user.id && m.role !== 'owner' && <IconButton title="Entfernen" onClick={async () => { if (confirm(`${m.user?.name} aus der Organisation entfernen?`)) { await api.org.removeMember(m.user_id); await org.reload() } }}><Trash2 size={14} /></IconButton>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title={<span className="flex items-center gap-2"><ShieldCheck size={15} /> Rollen & Berechtigungen</span>} padded={false}>
        <div className="overflow-x-auto">
          <table className="data-table w-full text-xs">
            <thead><tr><th>Berechtigung</th>{ROLES.map((r) => <th key={r} className="text-center">{ROLE_LABELS[r]}</th>)}</tr></thead>
            <tbody>
              {CAPS.map((c) => (
                <tr key={c.cap}><td className="font-medium">{c.label}</td>{ROLES.map((r) => <td key={r} className="text-center">{canRole(r, c.cap) ? <span className="text-ok">✓</span> : <span className="text-ink-faint">–</span>}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Modal open={!!invite} onClose={() => setInvite(null)} title="Mitglied hinzufügen" width="sm" footer={<><Button variant="ghost" onClick={() => setInvite(null)}>Abbrechen</Button><Button variant="primary" type="submit" form="invite-form">Hinzufügen</Button></>}>
        {invite && (
          <form id="invite-form" onSubmit={submit} className="space-y-3">
            <Field label="Name" required><Input value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} required autoFocus /></Field>
            <Field label="E-Mail" required><Input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required /></Field>
            <Field label="Rolle"><Select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value as OrgRole })}>{ROLES.filter((r) => r !== 'owner' || session?.role === 'owner').map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select></Field>
            <Field label="Startpasswort" hint="Leer = „willkommen1“. E-Mail-Einladungen folgen mit dem Benachrichtigungs-Dispatcher."><Input type="text" value={invite.password} onChange={(e) => setInvite({ ...invite, password: e.target.value })} /></Field>
          </form>
        )}
      </Modal>
    </div>
  )
}
