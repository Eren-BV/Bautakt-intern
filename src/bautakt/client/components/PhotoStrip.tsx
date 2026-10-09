import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, FileText, Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { uploadAttachment } from '../lib/attachments'
import type { Attachment } from '../../shared/types'

/** Fotos/Dateien zu einem Bautagebuch-Eintrag oder Mangel: Vorschau-Leiste plus Upload. */
export function PhotoStrip({ projectId, target, canEdit, label = 'Foto', onChange }: { projectId: string; target: { diary_entry_id?: string; defect_id?: string; task_id?: string }; canEdit: boolean; label?: string; onChange?: () => void }) {
  const [items, setItems] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const key = target.diary_entry_id ?? target.defect_id ?? target.task_id ?? ''

  const load = useCallback(() => {
    api.attachments.list(projectId, target as Record<string, string>).then(setItems).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key])
  useEffect(load, [load])

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    setError('')
    try {
      await uploadAttachment(projectId, file, target)
      load()
      onChange?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((a) =>
        a.mime.startsWith('image/') && a.url ? (
          <a key={a.id} href={a.url} target="_blank" rel="noreferrer" title={a.filename}><img src={a.url} alt={a.filename} className="h-16 w-16 rounded-lg border border-line object-cover" /></a>
        ) : (
          <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="flex h-16 items-center gap-1.5 rounded-lg border border-line px-2 text-xs text-ink-soft"><FileText size={14} /> {a.filename}</a>
        ),
      )}
      {canEdit && (
        <>
          <input ref={inputRef} type="file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.ppt,.pptx" className="hidden" onChange={onFile} />
          <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong text-[11px] text-ink-faint hover:border-brand hover:text-brand disabled:opacity-60">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}{label}
          </button>
        </>
      )}
      {error && <p className="w-full text-xs text-danger">{error}</p>}
    </div>
  )
}
