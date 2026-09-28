/**
 * Protokoll zwischen Jarvis-Client und -Server. Eine Gesprächsrunde ist ein
 * POST /api/jarvis/turn, dessen Antwort als Server-Sent-Events gestreamt wird.
 * Die Gesprächshistorie hält der Client; der Server behandelt sie als unvertrauenswürdig.
 */

export type JarvisItem =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export interface JarvisContext {
  /** Heutiges Datum in der Zeitzone des Nutzers (JJJJ-MM-TT) */
  today: string
  tz: string
  path: string
  project_id: string | null
  task_id: string | null
  view: 'desktop' | 'mobile'
}

export interface JarvisTurnRequest {
  turn_id: string
  /** Kennung des laufenden Gesprächs (z. B. für „mach das rückgängig“) */
  conversation_id?: string | null
  input: { text: string; via: 'voice' | 'text' }
  history: JarvisItem[]
  /** Antwort auf eine Bestätigungskarte - nur durch den Nutzer selbst, nie durch das Modell */
  confirm?: { action_id: string; decision: 'confirm' | 'cancel' } | null
  context: JarvisContext
}

export interface JarvisImpactRow {
  name: string
  old_start: string
  old_end: string
  new_start: string
  new_end: string
}

export interface JarvisConfirmation {
  action_id: string
  title: string
  lines: string[]
  impact: { old_end: string; new_end: string; affected: JarvisImpactRow[] } | null
  expires_at: string
}

export type JarvisUiEvent =
  | { type: 'ui'; action: 'navigate'; to: string }
  | { type: 'ui'; action: 'focus_task'; project_id: string; task_id: string; open_drawer: boolean }
  | { type: 'ui'; action: 'highlight'; project_id: string; task_ids: string[] }
  | { type: 'ui'; action: 'reload_project'; project_id: string; version: number }
  | { type: 'ui'; action: 'data_changed'; scope: 'site' | 'projects' | 'notifications' }

export type JarvisEvent =
  | { type: 'turn_start'; turn_id: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string; label: string }
  | { type: 'tool_update'; id: string; label: string }
  | {
      type: 'tool_end'
      id: string
      ok: boolean
      summary: string
      /** Warum nicht ok: wartet auf Bestätigung, Rückfrage nötig, nicht gefunden … */
      status?: 'needs_confirmation' | 'ambiguous' | 'not_found' | 'forbidden' | 'invalid' | 'conflict'
      /** Bei ok: rückgängig machbar; bei needs_confirmation: die zugehörige Bestätigungskarte */
      action_id?: string
      undoable?: boolean
      link?: { label: string; to: string }
    }
  | JarvisUiEvent
  | ({ type: 'confirm' } & JarvisConfirmation)
  | { type: 'items'; items: JarvisItem[] }
  | { type: 'done'; turn_id: string; expects_reply: boolean; timings: { first_text_ms: number | null; total_ms: number }; usage: { input: number; cached: number; output: number } }
  | { type: 'error'; code: 'ai_unavailable' | 'rate_limited' | 'credits' | 'forbidden' | 'conflict' | 'internal'; message: string }
