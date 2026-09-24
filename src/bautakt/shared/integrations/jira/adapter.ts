/**
 * Jira → Planentwurf. Grundlage ist die Jira-Cloud-Suche (GET /rest/api/3/search),
 * die Vorgänge als flache Liste liefert.
 *
 * Abbildung: Epic → Phase · Untergeordneter Vorgang → Aufgabe unter dem Epic ·
 * Meilenstein-artige Typen (Milestone) → Meilenstein · „is blocked by“ → Abhängigkeit.
 * Dauer kommt aus der Aufwandsschätzung (timeoriginalestimate, Story Points) oder
 * aus Start-/Fälligkeitsdatum, sonst 1 Arbeitstag.
 */

import type { TaskType } from '../../types.ts'
import type { ExtractedPlan, ExtractedTask } from '../planextract/types.ts'

export interface JiraIssue {
  id?: string
  key: string
  fields?: {
    summary?: string
    description?: unknown
    duedate?: string | null
    timeoriginalestimate?: number | null
    customfield_10016?: number | null // Story Points (Standardfeld in Jira Cloud)
    issuetype?: { name?: string; subtask?: boolean; hierarchyLevel?: number }
    status?: { name?: string }
    assignee?: { displayName?: string; emailAddress?: string } | null
    parent?: { key?: string } | null
    project?: { name?: string; key?: string }
    issuelinks?: {
      type?: { inward?: string; outward?: string }
      inwardIssue?: { key?: string }
      outwardIssue?: { key?: string }
    }[]
  }
}

export interface JiraSearchResponse {
  issues?: JiraIssue[]
  total?: number
}

const SECONDS_PER_WORKDAY = 8 * 3600

function typeOf(issue: JiraIssue): TaskType {
  const name = (issue.fields?.issuetype?.name ?? '').toLowerCase()
  const level = issue.fields?.issuetype?.hierarchyLevel ?? 0
  if (/milestone|meilenstein/.test(name)) return 'milestone'
  if (/epic/.test(name) || level >= 1) return 'phase'
  return 'task'
}

function durationOf(issue: JiraIssue): number {
  const f = issue.fields
  if (f?.timeoriginalestimate) return Math.max(1, Math.round(f.timeoriginalestimate / SECONDS_PER_WORKDAY))
  if (typeof f?.customfield_10016 === 'number' && f.customfield_10016 > 0) return Math.max(1, Math.round(f.customfield_10016))
  return 1
}

function responsibleOf(issue: JiraIssue): string | null {
  const a = issue.fields?.assignee
  return a?.emailAddress || a?.displayName || null
}

/** Beschreibung aus dem Atlassian-Document-Format als Klartext. */
function plainDescription(node: unknown, depth = 0): string {
  if (depth > 8 || node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map((n) => plainDescription(n, depth + 1)).join('')
  const o = node as { type?: string; text?: string; content?: unknown }
  if (typeof o.text === 'string') return o.text
  const inner = plainDescription(o.content, depth + 1)
  return o.type === 'paragraph' ? `${inner}\n` : inner
}

/** Jira-Suchergebnis in das neutrale Importformat übersetzen. */
export function jiraToExtractedPlan(res: JiraSearchResponse, planName: string, reference: string): ExtractedPlan {
  const issues = res.issues ?? []
  const warnings: string[] = []
  const keys = new Set(issues.map((i) => i.key))

  const phases = issues.filter((i) => typeOf(i) === 'phase')
  const others = issues.filter((i) => typeOf(i) !== 'phase')

  // Phasen zuerst, darunter die zugehörigen Vorgänge; danach Vorgänge ohne Epic.
  const ordered: JiraIssue[] = []
  for (const p of phases) {
    ordered.push(p)
    ordered.push(...others.filter((i) => i.fields?.parent?.key === p.key))
  }
  ordered.push(...others.filter((i) => !i.fields?.parent?.key || !keys.has(i.fields.parent.key)))

  const tasks: ExtractedTask[] = ordered.map((issue) => {
    const type = typeOf(issue)
    const parent = issue.fields?.parent?.key
    const notes = plainDescription(issue.fields?.description).trim().slice(0, 2000)
    const status = issue.fields?.status?.name
    return {
      key: issue.key,
      name: issue.fields?.summary?.trim() || issue.key,
      type,
      parent_key: type === 'phase' ? null : parent && keys.has(parent) ? parent : null,
      duration: type === 'milestone' ? 0 : durationOf(issue),
      responsible: responsibleOf(issue),
      notes: [status ? `Status: ${status}` : '', notes].filter(Boolean).join('\n'),
      depends_on: [],
    }
  })

  const byKey = new Map(tasks.map((t) => [t.key, t]))
  for (const issue of issues) {
    for (const link of issue.fields?.issuelinks ?? []) {
      // „is blocked by X“ bzw. „blocks X“ → Vorgänger-/Nachfolgerbeziehung
      const inward = (link.type?.inward ?? '').toLowerCase()
      const outward = (link.type?.outward ?? '').toLowerCase()
      if (link.inwardIssue?.key && /blocked by|depends on|folgt auf/.test(inward)) {
        const target = byKey.get(issue.key)
        if (target && byKey.has(link.inwardIssue.key)) {
          target.depends_on = [...(target.depends_on ?? []), { predecessor_key: link.inwardIssue.key, type: 'FS', lag_days: 0 }]
        }
      } else if (link.outwardIssue?.key && /^blocks/.test(outward)) {
        const target = byKey.get(link.outwardIssue.key)
        if (target && byKey.has(issue.key)) {
          target.depends_on = [...(target.depends_on ?? []), { predecessor_key: issue.key, type: 'FS', lag_days: 0 }]
        }
      }
    }
  }

  if (!tasks.length) warnings.push('Zu dieser Abfrage wurden keine Jira-Vorgänge gefunden.')
  if ((res.total ?? 0) > issues.length) warnings.push(`Es wurden ${issues.length} von ${res.total} Vorgängen geladen. Grenze die Abfrage weiter ein.`)

  return { source: 'document', name: planName, reference, tasks, warnings }
}
