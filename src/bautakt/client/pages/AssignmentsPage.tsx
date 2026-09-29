/**
 * Aufgaben: eigenständig und projektübergreifend, losgelöst vom Terminplan. Jemandem etwas mit
 * Fertigstellungs- und Erinnerungstermin geben; die Person gibt das Ergebnis zurück (Notiz +
 * Anhänge), der Auftraggeber schließt ab oder gibt mit Anmerkung zur Nacharbeit zurück.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Paperclip, Upload, Check, Undo2, Trash2, X } from 'lucide-react'
import { api } from '../lib/api'
import { uploadAttachment } from '../lib/attachments'
import { useAuth } from '../store/auth'
import { useOrg } from '../store/org'
import { useToast } from '../store/toast'
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Tabs, Textarea } from '../components/ui'
import type { AssignmentView, ProjectSummary } from '../../shared/types'
import { ASSIGNMENT_STATUS_LABELS } from '../../shared/labels'
import { formatDate, todayISO } from '../../shared/engine/dates'

type Scope = 'mine' | 'given'
const STATUS_TONE = { open: 'neutral', submitted: 'warn', done: 'ok' } as const

export function AssignmentsPage() {
  const { session } = useAuth()
  const org = useOrg()
  const toast = useToast()
  const [scope, setScope] = useState<Scope>('mine')
  const [data, setData] = useState<AssignmentView[] | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [create, setCreate] = useState(false)
  const [open, setOpen] = useState<AssignmentView | null>(null)

  const load = () => api.myTasks.list(scope).then((d) => { setData(d); return d }).catch((e) => { toast.push(e.message, 'error'); return null })
  useEffect(() => { setData(null); void load() }, [scope])
  useEffect(() => { api.projects.list().then((d) => setProjects(d.summaries)).catch(() => {}) }, [])

  const refresh = async () => {
    const fresh = await load()
    setOpen((o) => (o && fresh ? (fresh.find((a) => a.id === o.id) ?? null) : o))
  }

  const openCount = useMemo(() => (data ?? []).filter((a) => a.status !== 'done').length, [data])

  return (
    <div className="mx-auto max-w-[1100px] p-4 sm:p-6">
      <PageHeader
        title="Aufgaben"
        subtitle="Projektübergreifend – jemandem etwas mit Frist geben, unabhängig vom Terminplan"
        actions={<Button variant="primary" onClick={() => setCreate(true)}><Plus size={16} /> Aufgabe geben</Button>}
      />
      <Tabs
        className="mb-4"
        value={scope}
        onChange={setScope}
        items={[{ value: 'mine', label: 'Für mich' }, { value: 'given', label: 'Von mir vergeben' }]}
      />
      {!data ? <Spinner /> : data.length === 0 ? (
        <EmptyState title={scope === 'mine' ? 'Keine Aufgaben für dich' : 'Du hast noch keine Aufgaben vergeben'} description={scope === 'given' ? 'Gib jemandem eine Aufgabe mit Frist und optionaler Erinnerung.' : undefined} />
      ) : (
        <div className="space-y-2">
          {data.map((a) => (
            <button key={a.id} type="button" onClick={() => setOpen(a)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left hover:border-brand/40 hover:bg-surface-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{a.title}</span>
                  <Badge tone={STATUS_TONE[a.status]}>{ASSIGNMENT_STATUS_LABELS[a.status]}</Badge>
                </div>
                <div className="mt-0.5 truncate text-xs text-ink-faint">
                  {a.project_name}{a.task_name ? ` · ${a.task_name}` : ''} · {scope === 'mine' ? `von ${a.assigned_by_name}` : `an ${a.assigned_to_name}`}
                </div>
              </div>
              {a.due_date && <div className={`shrink-0 text-xs ${a.status !== 'done' && a.due_date < todayISO() ? 'font-semibold text-danger' : 'text-ink-soft'}`}>Fällig {formatDate(a.due_date)}</div>}
            </button>
          ))}
        </div>
      )}

      {create && projects && (
        <CreateDialog projects={projects} members={org.members} onClose={() => setCreate(false)} onCreated={async () => { setCreate(false); await load() }} />
      )}
      {open && (
        <DetailDialog assignment={open} isAssignee={open.assigned_to === session?.user.id} isAssigner={open.assigned_by === session?.user.id} onClose={() => setOpen(null)} onChanged={refresh} />
      )}
      <p className="mt-6 text-xs text-ink-faint">{openCount} offen{scope === 'given' ? ' / in Rückmeldung' : ''}.</p>
    </div>
  )
}

function CreateDialog({ projects, members, onClose, onCreated }: { projects: ProjectSummary[]; members: ReturnType<typeof useOrg>['members']; onClose: () => void; onCreated: () => void }) {
  const toast = useToast()
  const [projectId, setProjectId] = useState(projects[0]?.project.id ?? '')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assignedTo, setAssignedTo] = useState(members[0]?.user_id ?? '')
  const [dueDate, setDueDate] = useState('')
  const [reminderDate, setReminderDate] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const submit = async () => {
    if (!projectId || !title.trim() || !assignedTo) return toast.push('Projekt, Titel und Empfänger sind erforderlich.', 'error')
    setBusy(true)
    try {
      const a = await api.myTasks.create({ project_id: projectId, title, description, assigned_to: assignedTo, due_date: dueDate || null, reminder_date: reminderDate || null })
      for (const f of files) await uploadAttachment(projectId, f, { assignment_id: a.id })
      toast.push('Aufgabe erteilt.', 'success')
      onCreated()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Aufgabe geben" width="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Abbrechen</Button><Button variant="primary" loading={busy} onClick={submit}>Erteilen</Button></>}>
      <div className="space-y-3">
        <Field label="Projekt" required><Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>{projects.map((p) => <option key={p.project.id} value={p.project.id}>{p.project.name}</option>)}</Select></Field>
        <Field label="Titel" required><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Was soll erledigt werden?" /></Field>
        <Field label="Beschreibung"><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Für wen" required><Select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>{members.map((m) => <option key={m.user_id} value={m.user_id}>{m.user?.name}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fertigstellungstermin"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          <Field label="Erinnerungstermin" hint="Optional, unabhängig von der Frist"><Input type="date" value={reminderDate} onChange={(e) => setReminderDate(e.target.value)} /></Field>
        </div>
        <Field label="Unterlagen (optional)">
          <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => setFiles((f) => [...f, ...Array.from(e.target.files ?? [])])} />
          <Button size="sm" onClick={() => fileInput.current?.click()}><Paperclip size={14} /> Datei anhängen</Button>
          {files.length > 0 && <ul className="mt-2 space-y-1 text-xs">{files.map((f, i) => <li key={i} className="flex items-center justify-between gap-2 text-ink-soft">{f.name}<IconButton title="Entfernen" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}><X size={12} /></IconButton></li>)}</ul>}
        </Field>
      </div>
    </Modal>
  )
}

function DetailDialog({ assignment: a, isAssignee, isAssigner, onClose, onChanged }: { assignment: AssignmentView; isAssignee: boolean; isAssigner: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const toast = useToast()
  const [resultNote, setResultNote] = useState('')
  const [reopenNote, setReopenNote] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const withBusy = (fn: () => Promise<void>) => async () => {
    setBusy(true)
    try {
      await fn()
      await onChanged()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const submitResult = withBusy(async () => {
    for (const f of files) await uploadAttachment(a.project_id, f, { assignment_id: a.id, is_result: true })
    await api.myTasks.submit(a.id, resultNote)
    toast.push('Ergebnis zurückgegeben.', 'success')
  })
  const close = withBusy(async () => { await api.myTasks.close(a.id); toast.push('Aufgabe abgeschlossen.', 'success') })
  const reopen = withBusy(async () => { await api.myTasks.reopen(a.id, reopenNote); toast.push('An den Bearbeiter zurückgegeben.', 'success') })
  const remove = withBusy(async () => { await api.myTasks.remove(a.id); onClose() })

  const given = a.attachments.filter((x) => !x.is_result)
  const results = a.attachments.filter((x) => x.is_result)

  return (
    <Modal open onClose={onClose} title={a.title} width="sm">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
          <Badge tone={STATUS_TONE[a.status]}>{ASSIGNMENT_STATUS_LABELS[a.status]}</Badge>
          <span>{a.project_name}</span>
          {a.due_date && <span>· Fällig {formatDate(a.due_date)}</span>}
          {a.reminder_date && <span>· Erinnerung {formatDate(a.reminder_date)}</span>}
          <span>· {a.assigned_by_name} → {a.assigned_to_name}</span>
        </div>
        {a.description && <p className="text-sm whitespace-pre-wrap">{a.description}</p>}
        {given.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold text-ink-faint uppercase">Unterlagen</div>
            <ul className="space-y-1 text-sm">{given.map((f) => <li key={f.id}><a href={f.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">{f.filename}</a></li>)}</ul>
          </div>
        )}

        {a.status === 'open' && isAssignee && (
          <Card title="Ergebnis zurückgeben" padded>
            <Textarea rows={3} placeholder="Was wurde erledigt?" value={resultNote} onChange={(e) => setResultNote(e.target.value)} className="mb-2" />
            <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => setFiles((f) => [...f, ...Array.from(e.target.files ?? [])])} />
            <Button size="sm" onClick={() => fileInput.current?.click()}><Paperclip size={14} /> Datei anhängen</Button>
            {files.length > 0 && <ul className="mt-2 space-y-1 text-xs">{files.map((f, i) => <li key={i} className="text-ink-soft">{f.name}</li>)}</ul>}
            <Button className="mt-3" variant="primary" loading={busy} onClick={submitResult}><Upload size={14} /> Zurückgeben</Button>
          </Card>
        )}

        {a.status !== 'open' && (results.length > 0 || a.result_note) && (
          <div>
            <div className="mb-1 text-xs font-semibold text-ink-faint uppercase">Ergebnis</div>
            {a.result_note && <p className="text-sm whitespace-pre-wrap">{a.result_note}</p>}
            {results.length > 0 && <ul className="mt-1 space-y-1 text-sm">{results.map((f) => <li key={f.id}><a href={f.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">{f.filename}</a></li>)}</ul>}
          </div>
        )}

        {a.status === 'submitted' && isAssigner && (
          <div className="space-y-2">
            <Button variant="primary" loading={busy} onClick={close}><Check size={14} /> Abschließen</Button>
            <Field label="Zurückgeben mit Anmerkung (optional)">
              <div className="flex gap-2">
                <Input value={reopenNote} onChange={(e) => setReopenNote(e.target.value)} placeholder="Was fehlt noch?" />
                <Button loading={busy} onClick={reopen}><Undo2 size={14} /> Zurückgeben</Button>
              </div>
            </Field>
          </div>
        )}

        {a.status === 'open' && isAssigner && (
          <Button variant="ghost" loading={busy} onClick={remove}><Trash2 size={14} /> Aufgabe zurückziehen</Button>
        )}
      </div>
    </Modal>
  )
}
