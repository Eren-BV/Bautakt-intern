import { useRef, useState } from 'react'
import { Camera, Check, Loader2 } from 'lucide-react'
import { uploadAttachment } from '../lib/attachments'

/**
 * Datei-/Foto-Auswahl + Upload für einen bereits bekannten Vorgang und/oder ein bereits
 * bekanntes Vor-Ort-Update. Für Formulare, bei denen die Ziel-ID erst nach dem Absenden
 * entsteht (z. B. SitePage-Dialog), direkt `uploadAttachment()` aus lib/attachments.ts nutzen.
 */
export function AttachmentUploader({
  projectId,
  taskId,
  progressUpdateId,
  onUploaded,
}: {
  projectId: string
  taskId?: string | null
  progressUpdateId?: string | null
  onUploaded?: (attachmentId: string, filename: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [filename, setFilename] = useState('')
  const [error, setError] = useState('')

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setState('uploading')
    setFilename(file.name)
    setError('')
    try {
      const row = await uploadAttachment(projectId, file, { task_id: taskId, progress_update_id: progressUpdateId })
      setState('done')
      onUploaded?.(row.id, file.name)
    } catch (err) {
      setState('error')
      setError((err as Error).message)
    }
  }

  return (
    <div>
      <input ref={inputRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={onChange} />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={state === 'uploading'}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong py-3 text-sm text-ink-faint hover:border-brand hover:text-brand disabled:opacity-60"
      >
        {state === 'uploading' ? <Loader2 size={16} className="animate-spin" /> : state === 'done' ? <Check size={16} className="text-ok" /> : <Camera size={16} />}
        {state === 'uploading' ? `Lädt hoch: ${filename}` : state === 'done' ? `Hochgeladen: ${filename}` : 'Foto hinzufügen'}
      </button>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  )
}
