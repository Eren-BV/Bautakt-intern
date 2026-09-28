/**
 * Verwaltet den privaten Storage-Bucket für Datei-/Foto-Anhänge. Der Bucket bleibt privat -
 * Zugriff ausschließlich über kurzlebige signierte URLs, die der Server (Service-Role) ausstellt.
 */

export const ATTACHMENTS_BUCKET = 'attachments'
export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024
export const ALLOWED_ATTACHMENT_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']

interface StorageFileApi {
  createSignedUploadUrl(path: string): Promise<{ data: { signedUrl: string; token: string; path: string } | null; error: { message: string } | null }>
  createSignedUrl(path: string, expiresIn: number): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>
}
interface StorageClient {
  from(bucket: string): StorageFileApi
  getBucket(id: string): Promise<{ data: unknown; error: { message: string } | null }>
  createBucket(id: string, options: { public: boolean; fileSizeLimit?: number; allowedMimeTypes?: string[] }): Promise<{ data: unknown; error: { message: string } | null }>
}
interface AdminClient {
  storage: StorageClient
}

let adminPromise: Promise<AdminClient> | null = null

async function admin(): Promise<AdminClient> {
  if (!adminPromise) {
    adminPromise = import('@/integrations/supabase/client.server').then((m) => m.supabaseAdmin as unknown as AdminClient)
  }
  return adminPromise
}

/** Legt den privaten Bucket an, falls er noch nicht existiert (idempotent, läuft im Lazy-Init). */
export async function ensureAttachmentsBucket(): Promise<void> {
  const client = await admin()
  const { data } = await client.storage.getBucket(ATTACHMENTS_BUCKET)
  if (data) return
  const { error } = await client.storage.createBucket(ATTACHMENTS_BUCKET, {
    public: false,
    fileSizeLimit: MAX_ATTACHMENT_SIZE,
    allowedMimeTypes: ALLOWED_ATTACHMENT_MIME,
  })
  if (error && !/already exists/i.test(error.message)) {
    console.error(`[storage] Bucket "${ATTACHMENTS_BUCKET}" konnte nicht angelegt werden:`, error.message)
  }
}

export async function createUploadUrl(storageKey: string): Promise<{ signedUrl: string; token: string }> {
  const client = await admin()
  const { data, error } = await client.storage.from(ATTACHMENTS_BUCKET).createSignedUploadUrl(storageKey)
  if (error || !data) throw new Error(`Upload-URL konnte nicht erstellt werden: ${error?.message ?? 'unbekannter Fehler'}`)
  return data
}

export async function createViewUrl(storageKey: string, expiresInSeconds = 3600): Promise<string> {
  const client = await admin()
  const { data, error } = await client.storage.from(ATTACHMENTS_BUCKET).createSignedUrl(storageKey, expiresInSeconds)
  if (error || !data) throw new Error(`Lese-URL konnte nicht erstellt werden: ${error?.message ?? 'unbekannter Fehler'}`)
  return data.signedUrl
}
