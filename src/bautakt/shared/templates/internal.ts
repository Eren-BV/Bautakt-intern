/**
 * Interne Vorlagen für Aufgabenplanung, Coaching-Programme und Software-Entwicklung.
 * Gleiche Zeilenschreibweise wie builtin.ts: [key, parent, name, type, dauerAT, kategorie, deps].
 * Kategorien werden hier nicht verwendet (null) – Zuständigkeiten laufen über Personen.
 */

import type { TaskType, TemplateConstraint } from '../types.ts'

type Row = [key: string, parent: string | null, name: string, type: TaskType, duration: number, trade: string | null, deps?: string, section?: string | null, constraints?: TemplateConstraint[]]
const P = 'phase' as const, T = 'task' as const, M = 'milestone' as const

/** Interne Aufgaben & Prozesse: Auftrag klären → Umsetzung → Abschluss */
export const INTERN_AUFGABEN: Row[] = [
  ['ph_start', null, 'Auftrag & Klärung', P, 0, null],
  ['ms_start', 'ph_start', 'Startfreigabe', M, 0, null],
  ['ziel', 'ph_start', 'Ziel und Ergebnis festlegen', T, 2, null, 'ms_start'],
  ['umfang', 'ph_start', 'Aufgabenumfang abstimmen', T, 2, null, 'ziel'],
  ['verant', 'ph_start', 'Verantwortliche und Fristen festlegen', T, 1, null, 'umfang'],
  ['ph_um', null, 'Umsetzung', P, 0, null],
  ['vorb', 'ph_um', 'Unterlagen und Daten zusammenstellen', T, 3, null, 'verant'],
  ['bearb', 'ph_um', 'Bearbeitung', T, 10, null, 'vorb'],
  ['abstim', 'ph_um', 'Interne Abstimmung', T, 2, null, 'bearb'],
  ['frei', 'ph_um', 'Freigabe durch Leitung', T, 2, null, 'abstim', null, [{ type: 'approval', title: 'Freigabe liegt vor' }]],
  ['ms_frei', 'ph_um', 'Freigabe erteilt', M, 0, null, 'frei'],
  ['ph_ab', null, 'Abschluss', P, 0, null],
  ['doku', 'ph_ab', 'Dokumentation und Ablage', T, 2, null, 'ms_frei'],
  ['review', 'ph_ab', 'Rückblick und Verbesserungen', T, 1, null, 'doku'],
  ['ms_fertig', 'ph_ab', 'Aufgabe abgeschlossen', M, 0, null, 'review'],
]

/** Coaching- und Beratungsprogramm: Kick-off → Onboarding → Module → Betreuung → Abschluss */
export const COACHING_PROGRAMM: Row[] = [
  ['ph_vorb', null, 'Vorbereitung', P, 0, null],
  ['ms_kick', 'ph_vorb', 'Kick-off', M, 0, null],
  ['bedarf', 'ph_vorb', 'Bedarfsanalyse Teilnehmer', T, 3, null, 'ms_kick'],
  ['konzept', 'ph_vorb', 'Programmkonzept erstellen', T, 5, null, 'bedarf'],
  ['material', 'ph_vorb', 'Unterlagen und Materialien vorbereiten', T, 5, null, 'konzept'],
  ['ph_onb', null, 'Onboarding', P, 0, null],
  ['zugang', 'ph_onb', 'Zugänge und Plattform einrichten', T, 2, null, 'material'],
  ['welcome', 'ph_onb', 'Welcome-Call', T, 1, null, 'zugang'],
  ['ms_onb', 'ph_onb', 'Onboarding abgeschlossen', M, 0, null, 'welcome'],
  ['ph_mod', null, 'Programmmodule', P, 0, null],
  ['mod1', 'ph_mod', 'Modul 1 – Grundlagen', T, 10, null, 'ms_onb'],
  ['mod2', 'ph_mod', 'Modul 2 – Aufbau', T, 10, null, 'mod1'],
  ['mod3', 'ph_mod', 'Modul 3 – Umsetzung', T, 10, null, 'mod2'],
  ['ph_beg', null, 'Begleitung', P, 0, null],
  ['einzel', 'ph_beg', '1:1-Termine', T, 20, null, 'ms_onb:SS+5'],
  ['gruppe', 'ph_beg', 'Gruppen-Calls', T, 20, null, 'ms_onb:SS+5'],
  ['feedback', 'ph_beg', 'Zwischenfeedback einholen', T, 2, null, 'mod2'],
  ['ph_abschluss', null, 'Abschluss', P, 0, null],
  ['final', 'ph_abschluss', 'Abschlussgespräch', T, 2, null, 'mod3,einzel'],
  ['zert', 'ph_abschluss', 'Zertifikat und Auswertung', T, 2, null, 'final'],
  ['ms_ende', 'ph_abschluss', 'Programm abgeschlossen', M, 0, null, 'zert'],
]

/** Software-Entwicklung: Analyse → Konzept → Sprints → Test → Release */
export const SOFTWARE_PROJEKT: Row[] = [
  ['ph_an', null, 'Analyse & Konzept', P, 0, null],
  ['ms_start', 'ph_an', 'Projektstart', M, 0, null],
  ['anforder', 'ph_an', 'Anforderungen aufnehmen', T, 5, null, 'ms_start'],
  ['scope', 'ph_an', 'Funktionsumfang festlegen', T, 3, null, 'anforder'],
  ['ux', 'ph_an', 'UX-Konzept und Screens', T, 8, null, 'scope'],
  ['ui', 'ph_an', 'UI-Design', T, 8, null, 'ux'],
  ['ms_konzept', 'ph_an', 'Konzept freigegeben', M, 0, null, 'ui', null, [{ type: 'approval', title: 'Design vom Auftraggeber freigegeben' }]],
  ['ph_dev', null, 'Entwicklung', P, 0, null],
  ['setup', 'ph_dev', 'Projekt-Setup und Grundgerüst', T, 3, null, 'ms_konzept'],
  ['sprint1', 'ph_dev', 'Sprint 1 – Kernfunktionen', T, 10, null, 'setup'],
  ['sprint2', 'ph_dev', 'Sprint 2 – Erweiterungen', T, 10, null, 'sprint1'],
  ['sprint3', 'ph_dev', 'Sprint 3 – Feinschliff', T, 10, null, 'sprint2'],
  ['ph_test', null, 'Test & Qualitätssicherung', P, 0, null],
  ['qs', 'ph_test', 'Interne Tests', T, 5, null, 'sprint3'],
  ['fix', 'ph_test', 'Fehlerbehebung', T, 5, null, 'qs'],
  ['uat', 'ph_test', 'Abnahmetest mit Auftraggeber', T, 3, null, 'fix'],
  ['ms_abnahme', 'ph_test', 'Abnahme erteilt', M, 0, null, 'uat'],
  ['ph_rel', null, 'Release & Übergabe', P, 0, null],
  ['deploy', 'ph_rel', 'Livegang', T, 2, null, 'ms_abnahme'],
  ['schulung', 'ph_rel', 'Schulung und Dokumentation', T, 3, null, 'deploy'],
  ['ms_live', 'ph_rel', 'Software live', M, 0, null, 'schulung'],
]
