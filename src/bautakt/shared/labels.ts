import type { ConstructionMethod, DelayReason, DependencyType, HealthStatus, ProjectState, ProjectType, SiteFlag, TaskStatus, TaskType } from './types.ts'

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  efh: 'Einfamilienhaus',
  dhh: 'Doppelhaus',
  mfh: 'Mehrfamilienhaus',
  gewerbe: 'Gewerbebau',
  wohnung_sanierung: 'Wohnungssanierung',
  haus_sanierung: 'Haussanierung',
  bad_sanierung: 'Badsanierung',
  individuell: 'Individuell',
}

export const CONSTRUCTION_LABELS: Record<ConstructionMethod, string> = {
  massiv: 'Massiv',
  holzstaender: 'Holzständer',
  hybrid: 'Hybrid',
  individuell: 'Individuell',
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: 'Nicht begonnen',
  in_progress: 'In Arbeit',
  at_risk: 'Gefährdet',
  delayed: 'Verzögert',
  blocked: 'Blockiert',
  done: 'Fertig',
}

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  phase: 'Phase',
  group: 'Gewerk-Gruppe',
  task: 'Vorgang',
  milestone: 'Meilenstein',
}

export const DEPENDENCY_LABELS: Record<DependencyType, string> = {
  FS: 'Ende → Anfang (FS)',
  SS: 'Anfang → Anfang (SS)',
  FF: 'Ende → Ende (FF)',
  SF: 'Anfang → Ende (SF)',
}

export const DELAY_REASON_LABELS: Record<DelayReason, string> = {
  weather: 'Wetter',
  material: 'Material',
  staff: 'Personal',
  subcontractor: 'Nachunternehmer',
  predecessor: 'Vorleistung',
  planning: 'Planung',
  client: 'Bauherr',
  authority: 'Behörde',
  delivery: 'Lieferverzug',
  other: 'Sonstiges',
}

export const SITE_FLAG_LABELS: Record<SiteFlag, string> = {
  on_track: 'Im Plan',
  at_risk: 'Gefährdet',
  delayed: 'Verzögert',
  done: 'Erledigt',
}

export const CONSTRAINT_KIND_LABELS: Record<import('./types.ts').ConstraintKind, string> = {
  predecessor: 'Vorleistung',
  material: 'Material',
  planning: 'Planung',
  approval: 'Freigabe',
  staff: 'Personal',
  equipment: 'Gerät',
  authority: 'Behörde',
  client: 'Bauherr',
  other: 'Sonstiges',
}

export const CONSTRAINT_STATUS_LABELS: Record<import('./types.ts').ConstraintStatus, string> = {
  open: 'Offen',
  fulfilled: 'Erfüllt',
  blocked: 'Blockiert',
}

export const CHANGE_SOURCE_LABELS: Record<import('./types.ts').ChangeSource, string> = {
  MANUAL: 'Manuell',
  SITE_UPDATE: 'Baustellen-Update',
  SUBCONTRACTOR_PROPOSAL: 'Nachunternehmer-Vorschlag',
  SCENARIO_APPLY: 'Szenario übernommen',
  IMPORT: 'Import',
  WORK_PACKAGE: 'Arbeitspaket',
  EMAIL: 'E-Mail-Eingang',
  BUILDFLOW_SYNC: 'BuildFlow-Abgleich',
  FUTURE_AI: 'KI-Vorschlag',
}

export const PLANNING_KIND_LABELS: Record<import('./types.ts').PlanningKind, string> = {
  internal: 'Interne Aufgaben & Prozesse',
  coaching: 'Coaching & Beratung',
  software: 'Software-Entwicklung',
  free: 'Freier Ablauf',
  development: 'Projektentwicklung / Vorbereitung',
  construction: 'Bauausführung',
  process: 'Prozessbasierter Plan',
}

export const PLANNING_KIND_HINTS: Record<import('./types.ts').PlanningKind, string> = {
  internal: 'Interne Abläufe, Freigaben und Meilensteine mit persönlichen Zuständigkeiten und Fristen.',
  coaching: 'Programme und Betreuung: Kick-off, Onboarding, Module, 1:1-Termine, Abschluss.',
  software: 'Konzept, Design, Sprints, Tests und Release – mit Verantwortlichen je Aufgabe.',
  free: 'Beliebiger Ablauf ohne Vorgaben – Phasen, Aufgaben, Meilensteine, Abhängigkeiten.',
  development: 'Projektentwicklung: Machbarkeit, Planung, Kalkulation, Freigaben.',
  construction: 'Bauzeitenplan mit Gewerken und Bauabschnitten (Altbestand).',
  process: 'Aus einem Prozessdiagramm übernommen: Schritte werden Aufgaben, Verbindungen Abhängigkeiten.',
}

export const PROPOSAL_ORIGIN_LABELS: Record<import('./types.ts').ProposalOrigin, string> = {
  share_link: 'Gewerkeplan-Link',
  manual: 'Manuell',
  email: 'E-Mail',
  buildflow: 'BuildFlow',
  ai: 'KI',
}

export const HEALTH_LABELS: Record<HealthStatus, string> = {
  green: 'Im Plan',
  yellow: 'Gefährdet',
  red: 'Verspätet',
  grey: 'Pausiert',
}

export const PROJECT_STATE_LABELS: Record<ProjectState, string> = {
  planning: 'In Planung',
  active: 'Aktiv',
  paused: 'Pausiert',
  completed: 'Abgeschlossen',
}

export const DEFAULT_TRADES: { name: string; color: string }[] = [
  { name: 'Baustelleneinrichtung', color: '#64748b' },
  { name: 'Erdarbeiten', color: '#92400e' },
  { name: 'Rohbau', color: '#b45309' },
  { name: 'Zimmerer', color: '#a16207' },
  { name: 'Dachdecker', color: '#7c2d12' },
  { name: 'Fenster', color: '#0e7490' },
  { name: 'Elektro', color: '#ca8a04' },
  { name: 'SHK', color: '#1d4ed8' },
  { name: 'Trockenbau', color: '#6d28d9' },
  { name: 'Innenputz', color: '#be185d' },
  { name: 'Estrich', color: '#4d7c0f' },
  { name: 'Fliesen', color: '#0f766e' },
  { name: 'Maler', color: '#c2410c' },
  { name: 'Bodenleger', color: '#9333ea' },
  { name: 'Schreiner', color: '#854d0e' },
  { name: 'Außenanlagen', color: '#15803d' },
  { name: 'Bauleitung', color: '#334155' },
]
