/**
 * Werkzeug-Register von Jarvis. Die Definitionen sind bei jedem Modellaufruf identisch
 * (Prompt-Caching); Organisations- und Seitendaten stehen stattdessen im Kontext.
 */

import { HttpError } from '../../auth.ts'
import type { ToolCtx, ToolDef, ToolResult, Args } from './common.ts'
import { find, findFiles, findLucidDocuments, getBriefing, getProject, getTask, searchEmail } from './read.ts'
import { assignTask, changeSchedule, createProjectTool, createTaskTool, decideProposalTool, deleteTasksTool, fileEmailAttachment, importLucidDiagram, linkTasks, planWithAi, reportProgress, sendEmail, show, undoLast } from './write.ts'
import { appApi } from './app.ts'

export const TOOLS: ToolDef[] = [
  getBriefing, find, getProject, getTask, findFiles, findLucidDocuments, searchEmail,
  changeSchedule, createTaskTool, assignTask, reportProgress, createProjectTool, planWithAi,
  linkTasks, deleteTasksTool, decideProposalTool, undoLast, show, importLucidDiagram, sendEmail, fileEmailAttachment,
  appApi,
]

const byName = new Map(TOOLS.map((t) => [t.name, t]))

export const TOOL_DEFS = TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true }))

export function toolExists(name: string): boolean {
  return byName.has(name)
}

export async function executeTool(ctx: ToolCtx, name: string, args: Args): Promise<ToolResult> {
  const tool = byName.get(name)
  if (!tool) return { ok: false, status: 'invalid', message: `Unbekanntes Werkzeug „${name}“.` }
  ctx.emit({ type: 'tool_start', id: ctx.callId, name, label: tool.label(args) })
  try {
    const result = await tool.run(ctx, args)
    ctx.emit({
      type: 'tool_end',
      id: ctx.callId,
      ok: result.ok,
      summary: result.summary ?? (result.ok ? 'Erledigt' : String(result.message ?? 'Nicht möglich')),
      ...(result.status ? { status: result.status } : {}),
      ...(result.ok && result.action_id ? { action_id: result.action_id, undoable: !!result.undoable } : {}),
      ...(result.status === 'needs_confirmation' && result.action_id ? { action_id: result.action_id } : {}),
      ...(result.link ? { link: result.link } : {}),
    })
    return result
  } catch (e) {
    const message = e instanceof HttpError ? e.message : 'Interner Fehler bei der Ausführung.'
    if (!(e instanceof HttpError)) console.error(`[jarvis] Werkzeug ${name} fehlgeschlagen`, e)
    ctx.emit({ type: 'tool_end', id: ctx.callId, ok: false, summary: message })
    return { ok: false, status: e instanceof HttpError && e.status === 409 ? 'conflict' : 'invalid', message }
  }
}

export function parseArgs(raw: unknown): Args | null {
  if (raw && typeof raw === 'object') return raw as Args
  if (typeof raw !== 'string') return null
  try {
    const v = JSON.parse(raw || '{}')
    return v && typeof v === 'object' ? (v as Args) : null
  } catch {
    return null
  }
}
