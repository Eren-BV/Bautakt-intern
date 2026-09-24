/**
 * BuildFlow-Vertrag (Integration Layer). Bewusst nur die Teilmenge des BuildFlow-Datenmodells
 * (prozess-tool/src/types/process.ts), die für die Terminplanung relevant ist - keine enge
 * Kopplung: die Scheduling Engine kennt diese Typen nicht, der Adapter übersetzt in
 * Vorlagen-Strukturen (TemplateTask) bzw. Change-Proposal-Operationen.
 *
 * Quelle heute: JSON-Export aus BuildFlow („Exportieren“ → prozesse.json, Array von
 * ProcessTemplate). Später: HTTP-Provider mit denselben Typen.
 */

export type BuildFlowNodeKind = 'start' | 'ende' | 'aufgabe' | 'entscheidung' | 'dokument' | 'checkliste' | 'benachrichtigung' | 'warten'

export interface BuildFlowDuration {
  value: number
  unit: 'min' | 'std' | 'tage' | 'wochen'
}

export interface BuildFlowNode {
  id: string
  kind: BuildFlowNodeKind
  name: string
  description?: string
  /** Verantwortliche Rolle (ID in BuildFlow) */
  roleId?: string
  /** Übergeordneter Bereich → Unterprozess/Gruppe */
  area?: string
  /** Aktive Soll-Bearbeitungszeit */
  duration?: BuildFlowDuration
  /** Prozessdauer in Kalenderzeit (z. B. Behördenbearbeitung) */
  processDuration?: BuildFlowDuration
  /** Nur bei kind === 'warten' */
  wait?: { kind: 'dauer' | 'ereignis'; duration?: BuildFlowDuration; event?: string }
  /** Nur bei kind === 'entscheidung' */
  condition?: string
  /** Frist: Vorlauf vor Projektstart/-ende */
  scheduleAnchor?: 'projektstart' | 'projektende'
  leadTime?: BuildFlowDuration
  externalResponsible?: string
  priority?: 'niedrig' | 'normal' | 'hoch' | 'kritisch'
}

export interface BuildFlowEdge {
  id: string
  from: string
  to: string
  label?: string
}

export interface BuildFlowRole {
  id: string
  name: string
}

export interface BuildFlowProcess {
  id: string
  name: string
  category?: string
  description?: string
  version: number
  templateVersion?: string
  nodes: BuildFlowNode[]
  edges: BuildFlowEdge[]
  /** Optional mitgeliefert (Export enthält Rollen nicht zwingend) */
  roles?: BuildFlowRole[]
  updatedAt?: string
}

/**
 * Provider-Vertrag: woher kommen Prozesse? Heute nur Datei/JSON; ein HTTP-Provider
 * (BuildFlow-API) implementiert dasselbe Interface, ohne dass Adapter oder Engine sich ändern.
 */
export interface BuildFlowProvider {
  kind: 'file' | 'http'
  listProcesses(): Promise<Pick<BuildFlowProcess, 'id' | 'name' | 'version' | 'templateVersion' | 'updatedAt'>[]>
  getProcess(id: string): Promise<BuildFlowProcess | null>
}

/** Prüft grob, ob ein JSON-Objekt ein BuildFlow-Prozess (oder Export-Array) ist. */
export function parseBuildFlowExport(raw: unknown): BuildFlowProcess[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { templates?: unknown }).templates) ? (raw as { templates: unknown[] }).templates : [raw]
  const out: BuildFlowProcess[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const p = item as Partial<BuildFlowProcess>
    if (typeof p.id !== 'string' || typeof p.name !== 'string' || !Array.isArray(p.nodes) || !Array.isArray(p.edges)) continue
    out.push({
      id: p.id, name: p.name, category: p.category, description: p.description, version: Number(p.version ?? 1), templateVersion: p.templateVersion,
      nodes: p.nodes.filter((n): n is BuildFlowNode => !!n && typeof n === 'object' && typeof (n as BuildFlowNode).id === 'string' && typeof (n as BuildFlowNode).name === 'string'),
      edges: p.edges.filter((e): e is BuildFlowEdge => !!e && typeof e === 'object' && typeof (e as BuildFlowEdge).from === 'string' && typeof (e as BuildFlowEdge).to === 'string'),
      roles: Array.isArray(p.roles) ? p.roles : undefined, updatedAt: p.updatedAt,
    })
  }
  return out
}
