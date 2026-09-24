/**
 * E-Mail-Integration - Verträge (Integration Layer + AI Interpretation Layer).
 *
 *   EMAIL PROVIDER → EMAIL INGESTION → SENDER MATCHING → PROJECT MATCHING
 *   → CLASSIFICATION (regelbasiert heute, KI-Dienst später) → TASK MATCHING
 *   → STRUCTURED PROPOSAL → SCHEDULING IMPACT (Engine) → HUMAN REVIEW → APPLY
 *
 * Keine providerspezifische Logik in Scheduling-Komponenten: Provider liefern
 * `InboundEmailMessage`, alles Weitere ist providerunabhängig.
 */

import type { ISODate, ISODateTime, ProposalOperation } from '../../types.ts'

export type EmailProviderKind = 'manual' | 'imap' | 'microsoft365' | 'gmail' | 'webhook'

/** Providerneutrale Nachricht */
export interface InboundEmailMessage {
  id: string
  provider: EmailProviderKind
  external_id: string | null
  from_email: string
  from_name: string
  to_email: string
  subject: string
  body_text: string
  received_at: ISODateTime
}

/**
 * Provider-Vertrag: holt neue Nachrichten ab bzw. nimmt sie per Webhook entgegen.
 * Microsoft 365 / Gmail implementieren dieses Interface später mit echten Credentials;
 * bis dahin existiert nur der manuelle Eingang (UI/API).
 */
export interface EmailProviderAdapter {
  kind: EmailProviderKind
  /** Verbindung prüfen (Credentials, Postfach) */
  check(): Promise<{ ok: boolean; message: string }>
  /** Neue Nachrichten seit Cursor */
  fetch(sinceCursor: string | null): Promise<{ messages: InboundEmailMessage[]; cursor: string | null }>
}

export type EmailMessageType =
  | 'SCHEDULE_CHANGE'
  | 'MATERIAL_DELAY'
  | 'RESOURCE_PROBLEM'
  | 'MISSING_PRECONDITION'
  | 'APPROVAL_DELAY'
  | 'DELIVERY_CHANGE'
  | 'SCHEDULE_CONFIRMATION'
  | 'SCHEDULE_OPTIMIZATION'
  | 'GENERAL_INFORMATION'

export interface EmailAnalysis {
  /** Wer hat analysiert: regelbasiert (deterministische Heuristik) oder KI-Dienst */
  analyzer: 'rules' | 'ai'
  message_type: EmailMessageType
  confidence: number
  reason: string
  sender: { email: string; name: string }
  company_id: string | null
  company_name: string | null
  contact_id: string | null
  project_candidates: { project_id: string; project_name: string; score: number; why: string }[]
  task_candidates: { task_id: string; task_name: string; project_id: string; score: number; why: string }[]
  old_date: ISODate | null
  new_date: ISODate | null
  /** Alle erkannten Datumsangaben im Text (Reihenfolge des Auftretens) */
  dates: ISODate[]
  /** Erkannte Verzögerung in Tagen (aus Datumspaar oder Text) */
  delta_days: number | null
  /** Vorgeschlagene Operationen (leer, wenn nichts Terminrelevantes erkannt wurde) */
  operations: ProposalOperation[]
  /** Zusätzliche Erkenntnisse: Material-Constraint, fehlende Abhängigkeit, Ressourcenproblem … */
  hints: { kind: EmailMessageType; text: string }[]
  original_message_id: string
}

/** Kontext, den der Analyzer bekommt - reine Daten, kein DB-Zugriff. */
export interface EmailAnalysisContext {
  today: ISODate
  companies: { id: string; name: string; email: string; trade_ids: string[] }[]
  contacts: { id: string; company_id: string; name: string; email: string; project_ids: string[] }[]
  projects: { id: string; name: string; number: string; customer: string; address: string; city: string; state: string }[]
  /** Vorgänge mit Terminen (nur Blätter, nicht erledigt) */
  tasks: { id: string; project_id: string; name: string; start_date: ISODate; end_date: ISODate; trade_id: string | null; company_id: string | null; status: string }[]
  /** Firma → Projekte, in denen sie eingeplant ist (aus tasks.company_id) */
  shareLinks: { project_id: string; company_id: string | null; trade_id: string | null }[]
}

/**
 * Analyzer-Vertrag. Heute: `RuleBasedEmailAnalyzer` (Datums-/Schlüsselwort-Heuristik,
 * deterministisch). Später: KI-Analyzer mit demselben Vertrag; die KI darf lesen,
 * klassifizieren, zuordnen, extrahieren und VORSCHLAGEN - nie den Plan verändern.
 */
export interface EmailAnalyzer {
  kind: 'rules' | 'ai'
  analyze(message: InboundEmailMessage, ctx: EmailAnalysisContext): Promise<EmailAnalysis>
}

export const EMAIL_TYPE_LABELS: Record<EmailMessageType, string> = {
  SCHEDULE_CHANGE: 'Terminverschiebung',
  MATERIAL_DELAY: 'Materialverzögerung',
  RESOURCE_PROBLEM: 'Ressourcenproblem',
  MISSING_PRECONDITION: 'Fehlende Voraussetzung',
  APPROVAL_DELAY: 'Freigabe fehlt',
  DELIVERY_CHANGE: 'Lieferänderung',
  SCHEDULE_CONFIRMATION: 'Terminbestätigung',
  SCHEDULE_OPTIMIZATION: 'Mögliche Terminoptimierung',
  GENERAL_INFORMATION: 'Allgemeine Information',
}
