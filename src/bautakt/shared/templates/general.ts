/**
 * Nicht-baubezogene Vorlagen: Projektentwicklung/Vorbereitung, phasenübergreifendes
 * Gesamtprojekt (Entwicklung → Übergabe) und ein freies Grundgerüst. Gleiche Zeilen-
 * Schreibweise wie builtin.ts; Kategorie meist leer, Voraussetzungen als Constraints.
 */

import type { TaskType, TemplateConstraint } from '../types.ts'

type Row = [key: string, parent: string | null, name: string, type: TaskType, duration: number, trade: string | null, deps?: string, section?: string | null, constraints?: TemplateConstraint[]]
const P = 'phase' as const, G = 'group' as const, T = 'task' as const, M = 'milestone' as const

/** Neubauprojekt – Vorbereitung bis Baubeginn (ca. 6–7 Monate) */
export const PROJEKTENTWICKLUNG: Row[] = [
  ['ms_kick', null, 'Projektstart', M, 0, null],
  ['grund', null, 'Grundstück prüfen', T, 10, null, 'ms_kick', null, [{ type: 'planning', title: 'Grundbuchauszug & Flächennutzungsplan liegen vor' }]],
  ['machbar', null, 'Machbarkeit', T, 10, null, 'grund'],
  ['entwurf', null, 'Entwurfsplanung', T, 25, null, 'machbar', null, [{ type: 'client', title: 'Raumprogramm vom Bauherrn bestätigt' }]],
  ['ph_kalk', null, 'Kalkulation', P, 0, null],
  ['mengen', 'ph_kalk', 'Mengen ermitteln', T, 5, null, 'entwurf'],
  ['angebote', 'ph_kalk', 'Angebote einholen', T, 15, null, 'mengen'],
  ['kalk_frei', 'ph_kalk', 'Kalkulation freigeben', T, 3, null, 'angebote'],
  ['finanz', null, 'Finanzierung', T, 20, null, 'kalk_frei:SS+5', null, [{ type: 'client', title: 'Finanzierungszusage der Bank' }]],
  ['ph_antrag', null, 'Bauantrag', P, 0, null],
  ['unterlagen', 'ph_antrag', 'Unterlagen vorbereiten', T, 10, null, 'entwurf'],
  ['einreichen', 'ph_antrag', 'Einreichen', T, 1, null, 'unterlagen,kalk_frei'],
  ['genehmigung', 'ph_antrag', 'Genehmigungsverfahren (Behörde)', T, 60, null, 'einreichen', null, [{ type: 'authority', title: 'Vollständigkeitsbestätigung der Behörde' }]],
  ['ms_genehmigt', 'ph_antrag', 'Baugenehmigung erteilt', M, 0, null, 'genehmigung'],
  ['ausschreibung', null, 'Ausschreibung', T, 20, null, 'kalk_frei'],
  ['vergabe', null, 'Vergabe', T, 10, null, 'ausschreibung,finanz', null, [{ type: 'client', title: 'Bauvertrag unterschrieben' }]],
  ['ms_baubeginn', null, 'Baubeginn', M, 0, null, 'vergabe,ms_genehmigt'],
]

/** Gesamtprojekt: Projektentwicklung → Planung → Genehmigung → Kalkulation → Vergabe → Bauausführung → Übergabe */
export const GESAMTPROJEKT: Row[] = [
  ['ph_pe', null, 'Projektentwicklung', P, 0, null],
  ['pe_grund', 'ph_pe', 'Grundstück prüfen', T, 10, null],
  ['pe_machbar', 'ph_pe', 'Machbarkeit & Wirtschaftlichkeit', T, 10, null, 'pe_grund'],
  ['pe_ms', 'ph_pe', 'Entscheidung: Projekt weiterverfolgen', M, 0, null, 'pe_machbar'],
  ['ph_plan', null, 'Planung', P, 0, null],
  ['pl_vor', 'ph_plan', 'Vorentwurf', T, 15, null, 'pe_ms'],
  ['pl_entwurf', 'ph_plan', 'Entwurfsplanung', T, 25, null, 'pl_vor', null, [{ type: 'client', title: 'Entwurf vom Bauherrn freigegeben' }]],
  ['pl_statik', 'ph_plan', 'Statik & Fachplanung', T, 20, null, 'pl_entwurf:SS+10'],
  ['ph_gen', null, 'Genehmigung', P, 0, null],
  ['gen_unterlagen', 'ph_gen', 'Bauantrag vorbereiten', T, 10, null, 'pl_entwurf'],
  ['gen_verfahren', 'ph_gen', 'Genehmigungsverfahren', T, 60, null, 'gen_unterlagen'],
  ['gen_ms', 'ph_gen', 'Baugenehmigung erteilt', M, 0, null, 'gen_verfahren'],
  ['ph_kalk', null, 'Kalkulation', P, 0, null],
  ['k_mengen', 'ph_kalk', 'Mengen ermitteln', T, 5, null, 'pl_statik'],
  ['k_angebote', 'ph_kalk', 'Angebote einholen', T, 15, null, 'k_mengen'],
  ['k_frei', 'ph_kalk', 'Kalkulation freigeben', T, 3, null, 'k_angebote'],
  ['ph_vergabe', null, 'Vergabe', P, 0, null],
  ['v_ausschr', 'ph_vergabe', 'Ausschreibung', T, 20, null, 'k_frei'],
  ['v_vergabe', 'ph_vergabe', 'Vergabe Nachunternehmer', T, 10, null, 'v_ausschr'],
  ['v_ms', 'ph_vergabe', 'Baubeginn', M, 0, null, 'v_vergabe,gen_ms'],
  ['ph_bau', null, 'Bauausführung', P, 0, null],
  ['b_roh', 'ph_bau', 'Rohbau', G, 0, null],
  ['b_erd', 'b_roh', 'Erdarbeiten & Bodenplatte', T, 15, 'Erdarbeiten', 'v_ms'],
  ['b_mauer', 'b_roh', 'Rohbau Geschosse', T, 40, 'Rohbau', 'b_erd'],
  ['b_dach', 'b_roh', 'Dach', T, 15, 'Dachdecker', 'b_mauer'],
  ['b_ms_roh', 'b_roh', 'Rohbau fertig / Gebäude dicht', M, 0, null, 'b_dach'],
  ['b_ausbau', 'ph_bau', 'Ausbau', G, 0, null],
  ['b_inst', 'b_ausbau', 'Installationen (Elektro, SHK)', T, 25, 'SHK', 'b_ms_roh'],
  ['b_putz', 'b_ausbau', 'Innenputz & Estrich', T, 20, 'Innenputz', 'b_inst'],
  ['b_fertig', 'b_ausbau', 'Fertigausbau (Fliesen, Maler, Böden)', T, 30, 'Maler', 'b_putz:FS+21'],
  ['ph_ueb', null, 'Übergabe', P, 0, null],
  ['u_abnahme', 'ph_ueb', 'Abnahme & Mängelbeseitigung', T, 10, 'Bauleitung', 'b_fertig'],
  ['u_ms', 'ph_ueb', 'Übergabe an Bauherrn', M, 0, null, 'u_abnahme'],
]

/** Freies Grundgerüst: Initiierung → Planung → Umsetzung → Abschluss */
export const FREIER_PLAN: Row[] = [
  ['ph_init', null, 'Initiierung', P, 0, null],
  ['i_ziel', 'ph_init', 'Ziele & Umfang festlegen', T, 3, null],
  ['i_ms', 'ph_init', 'Projektauftrag freigegeben', M, 0, null, 'i_ziel'],
  ['ph_plan', null, 'Planung', P, 0, null],
  ['p_konzept', 'ph_plan', 'Konzept erarbeiten', T, 10, null, 'i_ms'],
  ['p_abstimmung', 'ph_plan', 'Abstimmung mit Beteiligten', T, 5, null, 'p_konzept'],
  ['ph_ums', null, 'Umsetzung', P, 0, null],
  ['u_1', 'ph_ums', 'Arbeitspaket 1', T, 10, null, 'p_abstimmung'],
  ['u_2', 'ph_ums', 'Arbeitspaket 2', T, 10, null, 'u_1:SS+5'],
  ['u_3', 'ph_ums', 'Arbeitspaket 3', T, 5, null, 'u_1,u_2'],
  ['ph_ende', null, 'Abschluss', P, 0, null],
  ['e_review', 'ph_ende', 'Abnahme & Review', T, 3, null, 'u_3'],
  ['e_ms', 'ph_ende', 'Projektabschluss', M, 0, null, 'e_review'],
]
