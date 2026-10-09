/**
 * Dokumente des Projekts an einer Stelle: alle Anhänge der Vorgänge, thematisch nach Phase
 * sortiert (die Phase ist die Einteilung des Plans), darunter je Vorgang die Dateien.
 * Hochladen geht hier oder direkt im Vorgang (Reiter Überblick); im Gantt zeigt eine
 * Büroklammer am Balken, dass der Vorgang Dokumente enthält.
 */

import { useMemo, useRef, useState } from 'react'
import { FileSpreadsheet, FileText, FolderOpen, Image as ImageIcon, Paperclip, Search, Trash2, Upload } from 'lucide-react'
import { useProject } from '../store/project'
import { useToast } from '../store/toast'
import { api } from '../lib/api'
import { navigate } from '../lib/router'
import { uploadAttachment } from '../lib/attachments'
import { ProjectHeader } from '../components/ProjectHeader'
import { Button, Card, EmptyState, Field, Input, Modal, Select } from '../components/ui'
import type { Attachment, Task } from '../../shared/types'
import { formatDate } from '../../shared/engine/dates'
import { flattenTree } from '../../shared/engine/operations'

const NO_PHASE = '__none__'

function fileIcon(a: Attachment) {
  if (a.mime.startsWith('image/')) return <ImageIcon size={16} />
  if (/sheet|excel|csv/.test(a.mime)) return <FileSpreadsheet size={16} />
  return <FileText size={16} />
}
const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

export function DocumentsPage() {
  const p = useProject()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [upload, setUpload] = useState<{ taskId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const canWrite = p.canEdit

  const flat = useMemo(() => flattenTree(p.plan.tasks), [p.plan.tasks])
  const byId = useMemo(() => new Map(p.plan.tasks.map((t) => [t.id, t])), [p.plan.tasks])

  /** Nächste Phase oberhalb (oder der Vorgang selbst, wenn er eine Phase ist). */
  const phaseOf = (t: Task): string => {
    let cur: Task | undefined = t
    for (let i = 0; cur && i < 50; i++) {
      if (cur.type === 'phase') return cur.id
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
    }
    return NO_PHASE
  }

  const sections = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const files = p.documents.filter((a) => !needle || a.filename.toLowerCase().includes(needle))
    const filesByTask = new Map<string, Attachment[]>()
    const loose: Attachment[] = []
    for (const a of files) {
      if (a.task_id && byId.has(a.task_id)) {
        if (!filesByTask.has(a.task_id)) filesByTask.set(a.task_id, [])
        filesByTask.get(a.task_id)!.push(a)
      } else loose.push(a)
    }
    const out: { phaseId: string; title: string; tasks: { task: Task; files: Attachment[] }[] }[] = []
    const index = new Map<string, number>()
    for (const f of flat) {
      const list = filesByTask.get(f.task.id)
      if (!list) continue
      const pid = phaseOf(f.task)
      if (!index.has(pid)) {
        index.set(pid, out.length)
        out.push({ phaseId: pid, title: pid === NO_PHASE ? 'Ohne Phase' : byId.get(pid)!.name, tasks: [] })
      }
      out[index.get(pid)!]!.tasks.push({ task: f.task, files: list })
    }
    return { out, loose }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.documents, flat, byId, q])

  const open = async (a: Attachment) => {
    try {
      const { url } = await api.attachments.url(p.projectId, a.id)
      window.open(url, '_blank', 'noopener')
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const remove = async (a: Attachment) => {
    if (!confirm(`„${a.filename}“ löschen?`)) return
    try {
      await api.attachments.remove(p.projectId, a.id)
      await p.reloadDocuments()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const doUpload = async (files: FileList | null) => {
    if (!files?.length || !upload) return
    setBusy(true)
    try {
      for (const f of Array.from(files)) await uploadAttachment(p.projectId, f, { task_id: upload.taskId || null })
      toast.push(`${files.length} Datei(en) hochgeladen.`, 'success')
      setUpload(null)
      await p.reloadDocuments()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const fileRow = (a: Attachment) => (
    <div key={a.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
      <span className="text-ink-faint">{fileIcon(a)}</span>
      <button className="min-w-0 flex-1 truncate text-left font-medium hover:text-brand hover:underline" title={a.filename} onClick={() => open(a)}>{a.filename}</button>
      <span className="hidden shrink-0 text-xs text-ink-faint sm:inline">{sizeLabel(a.size)} · {formatDate(a.created_at.slice(0, 10))}</span>
      {canWrite && <button className="text-ink-faint hover:text-danger" title="Löschen" onClick={() => remove(a)}><Trash2 size={14} /></button>}
    </div>
  )
  const empty = sections.out.length === 0 && sections.loose.length === 0

  return (
    <>
      <ProjectHeader title="Dokumente" />
      <div className="mx-auto max-w-[1000px] p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Dateiname suchen …" className="h-9 w-64 pl-8" />
          </div>
          <span className="text-xs text-ink-faint">{p.documents.length} Dokument(e) · sortiert nach Phasen des Plans</span>
          {canWrite && <Button variant="primary" className="ml-auto" onClick={() => setUpload({ taskId: '' })}><Upload size={15} /> Dokument hochladen</Button>}
        </div>

        {empty && <EmptyState icon={<FolderOpen size={28} />} title={q ? 'Keine Treffer' : 'Noch keine Dokumente'} description="Hängen Sie Angebote, Pläne und Unterlagen an die Vorgänge – hier erscheinen sie nach Phasen geordnet." />}

        <div className="space-y-4">
          {sections.out.map((s) => (
            <Card key={s.phaseId} title={<span className="flex items-center gap-2"><FolderOpen size={15} className="text-brand" /> {s.title}</span>}>
              <div className="space-y-3">
                {s.tasks.map(({ task, files }) => (
                  <div key={task.id}>
                    <button className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-ink-soft hover:text-brand" onClick={() => navigate(`/projects/${p.projectId}/gantt?task=${task.id}`)} title="Im Terminplan öffnen">
                      <Paperclip size={12} /> {task.name}
                    </button>
                    <div className="space-y-1">{files.map(fileRow)}</div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
          {sections.loose.length > 0 && (
            <Card title={<span className="flex items-center gap-2"><FolderOpen size={15} className="text-ink-faint" /> Ohne Zuordnung</span>}>
              <div className="space-y-1">{sections.loose.map(fileRow)}</div>
            </Card>
          )}
        </div>
      </div>

      <Modal open={!!upload} onClose={() => setUpload(null)} title="Dokument hochladen" width="md" footer={<Button variant="ghost" onClick={() => setUpload(null)}>Abbrechen</Button>}>
        {upload && (
          <div className="space-y-3">
            <Field label="Zu welchem Vorgang gehört das Dokument?" hint="Die Phase ergibt sich aus dem Plan. Ohne Auswahl landet die Datei unter „Ohne Zuordnung“.">
              <Select value={upload.taskId} onChange={(e) => setUpload({ taskId: e.target.value })}>
                <option value="">– ohne Zuordnung –</option>
                {flat.map((f) => <option key={f.task.id} value={f.task.id}>{'  '.repeat(f.depth)}{f.task.name}</option>)}
              </Select>
            </Field>
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void doUpload(e.target.files)} />
            <Button variant="primary" loading={busy} onClick={() => fileRef.current?.click()}><Upload size={15} /> Dateien wählen</Button>
            <p className="text-xs text-ink-faint">PDF, Bilder, Word, Excel, CSV und Text bis 20 MB.</p>
          </div>
        )}
      </Modal>
    </>
  )
}
