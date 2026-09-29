import { supabase } from '@/integrations/supabase/client'
import { api } from './api'
import type { Attachment } from '../../shared/types'

export interface AttachmentTarget {
  task_id?: string | null
  progress_update_id?: string | null
  assignment_id?: string | null
  is_result?: boolean
}

/** Lädt eine Datei hoch: signierte URL anfordern, direkt zu Storage hochladen, Metadaten bestätigen. */
export async function uploadAttachment(projectId: string, file: File, target: AttachmentTarget = {}): Promise<Attachment> {
  const mime = file.type || 'application/octet-stream'
  const { attachment_id, storage_key, token } = await api.attachments.uploadUrl(projectId, { filename: file.name, mime, size: file.size, ...target })
  const { error } = await supabase.storage.from('attachments').uploadToSignedUrl(storage_key, token, file)
  if (error) throw new Error(`Upload fehlgeschlagen: ${error.message}`)
  return api.attachments.confirm(projectId, { id: attachment_id, filename: file.name, mime, size: file.size, storage_key, ...target })
}
