import { supabase } from '@/integrations/supabase/client'
import { api } from './api'
import type { Attachment } from '../../shared/types'

export interface AttachmentTarget {
  task_id?: string | null
  progress_update_id?: string | null
  assignment_id?: string | null
  is_result?: boolean
}

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic',
}

/** Dateityp bestimmen; Browser liefern z. B. für CSV unter Windows oft nichts Brauchbares. */
export function guessMime(file: File): string {
  if (file.type && file.type !== 'application/octet-stream') return file.type
  return EXT_MIME[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

/** Lädt eine Datei hoch: signierte URL anfordern, direkt zu Storage hochladen, Metadaten bestätigen. */
export async function uploadAttachment(projectId: string, file: File, target: AttachmentTarget = {}): Promise<Attachment> {
  const mime = guessMime(file)
  const { attachment_id, storage_key, token } = await api.attachments.uploadUrl(projectId, { filename: file.name, mime, size: file.size, ...target })
  const { error } = await supabase.storage.from('attachments').uploadToSignedUrl(storage_key, token, file.type === mime ? file : new File([file], file.name, { type: mime }))
  if (error) throw new Error(`Upload fehlgeschlagen: ${error.message}`)
  return api.attachments.confirm(projectId, { id: attachment_id, filename: file.name, mime, size: file.size, storage_key, ...target })
}
