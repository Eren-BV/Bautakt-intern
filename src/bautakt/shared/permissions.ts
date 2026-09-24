/**
 * Rollen → Fähigkeiten. Server prüft über `can()` in der Middleware, der Client
 * blendet Bedienelemente aus. Eine einzige Wahrheit für beide Seiten.
 */

import type { OrgRole } from './types.ts'

export type Capability =
  | 'org.manage'
  | 'org.members.manage'
  | 'project.create'
  | 'project.delete'
  | 'project.edit'
  | 'project.view'
  | 'plan.edit'
  | 'baseline.save'
  | 'site.update'
  | 'templates.manage'
  | 'resources.manage'
  | 'calendar.manage'
  | 'reports.view'
  | 'scenario.manage'
  | 'integrations.manage'
  | 'inbox.view'
  | 'rules.manage'

const ALL: Capability[] = [
  'org.manage',
  'org.members.manage',
  'project.create',
  'project.delete',
  'project.edit',
  'project.view',
  'plan.edit',
  'baseline.save',
  'site.update',
  'templates.manage',
  'resources.manage',
  'calendar.manage',
  'reports.view',
  'scenario.manage',
  'integrations.manage',
  'inbox.view',
  'rules.manage',
]

const MATRIX: Record<OrgRole, Capability[]> = {
  owner: ALL,
  admin: ALL.filter((c) => c !== 'org.manage'),
  management: ['project.create', 'project.edit', 'project.view', 'plan.edit', 'baseline.save', 'site.update', 'templates.manage', 'resources.manage', 'calendar.manage', 'reports.view', 'scenario.manage', 'integrations.manage', 'inbox.view', 'rules.manage'],
  project_manager: ['project.create', 'project.edit', 'project.view', 'plan.edit', 'baseline.save', 'site.update', 'templates.manage', 'resources.manage', 'calendar.manage', 'reports.view', 'scenario.manage', 'inbox.view', 'rules.manage'],
  site_manager: ['project.view', 'plan.edit', 'site.update', 'reports.view', 'inbox.view'],
  employee: ['project.view', 'site.update', 'reports.view'],
  subcontractor: ['project.view', 'site.update'],
  viewer: ['project.view', 'reports.view'],
}

export function can(role: OrgRole | null | undefined, cap: Capability): boolean {
  if (!role) return false
  return MATRIX[role]?.includes(cap) ?? false
}

export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: 'Inhaber',
  admin: 'Administrator',
  management: 'Geschäftsführung',
  project_manager: 'Projektleiter',
  site_manager: 'Bauleiter',
  employee: 'Mitarbeiter',
  subcontractor: 'Nachunternehmer',
  viewer: 'Nur Lesen',
}

export const ROLES: OrgRole[] = ['owner', 'admin', 'management', 'project_manager', 'site_manager', 'employee', 'subcontractor', 'viewer']
