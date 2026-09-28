/**
 * Signalisiert anderen Clients über Supabase Realtime Broadcast, dass sich etwas geändert hat
 * (kein postgres_changes, kein RLS nötig - das Schema `bautakt` ist ohnehin nur für service_role
 * erreichbar). Der Payload trägt nur Art + IDs, nie Inhalte: Kanalnamen sind ausschließlich durch
 * unratbare IDs (newId()) geschützt, keine echte Autorisierung. Clients holen die eigentlichen
 * Daten immer über die bestehenden authentifizierten REST-Endpunkte nach.
 */

import { nowISO } from '../db.ts'

export type BroadcastKind = 'plan' | 'baseline' | 'proposal' | 'notification' | 'attachment'

interface BroadcastChannel {
  httpSend(event: string, payload: unknown): Promise<{ success?: boolean }>
}
interface BroadcastClient {
  channel(name: string): BroadcastChannel
}

let adminPromise: Promise<BroadcastClient> | null = null

// Dynamischer Import wie in db.ts: hält den Service-Role-Client aus Bundles heraus, die nicht
// serverseitig sind (siehe Hinweis in client.server.ts).
async function admin(): Promise<BroadcastClient> {
  if (!adminPromise) {
    adminPromise = import('@/integrations/supabase/client.server').then((m) => m.supabaseAdmin as unknown as BroadcastClient)
  }
  return adminPromise
}

async function send(channelName: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const client = await admin()
    await client.channel(channelName).httpSend('change', { at: nowISO(), ...payload })
  } catch (err) {
    // Zustellfehler blockieren die eigentliche Schreiboperation nicht.
    console.error(`[realtime] Broadcast auf "${channelName}" fehlgeschlagen`, err)
  }
}

export async function broadcastProject(orgId: string, projectId: string, kind: BroadcastKind, extra?: Record<string, unknown>): Promise<void> {
  await send(`project:${projectId}`, { kind, org_id: orgId, project_id: projectId, ...extra })
}

export async function broadcastOrg(orgId: string, kind: BroadcastKind, extra?: Record<string, unknown>): Promise<void> {
  await send(`org:${orgId}`, { kind, org_id: orgId, ...extra })
}
