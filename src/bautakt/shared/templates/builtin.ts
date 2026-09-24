/**
 * Mitgelieferte Projektvorlagen. Kompakte Zeilenschreibweise:
 *   [key, parentKey, name, type, dauerAT, gewerk, abhängigkeiten]
 * Abhängigkeiten: "key" (FS, Lag 0) oder "key:SS+2" / "key:FS-1".
 * Werden beim ersten Start in `project_templates`/`template_tasks` (org_id NULL) importiert
 * und beim Anlegen eines Projekts durch die Engine terminiert.
 */

import type { ConstructionMethod, DependencyType, PlanningKind, ProjectType, TaskType, TemplateConstraint, TemplateDependency } from '../types.ts'
import { DHH_MASSIV_V1 } from './dhh.ts'
import { FREIER_PLAN, GESAMTPROJEKT, PROJEKTENTWICKLUNG } from './general.ts'

type Row = [key: string, parent: string | null, name: string, type: TaskType, duration: number, trade: string | null, deps?: string, section?: string | null, constraints?: TemplateConstraint[]]

export interface BuiltinTemplate {
  id: string
  name: string
  description: string
  planning_kind: PlanningKind
  project_type: ProjectType | null
  construction_method: ConstructionMethod | null
  rows: Row[]
}

export function parseDeps(spec: string | undefined): TemplateDependency[] {
  if (!spec) return []
  return spec.split(',').map((s) => {
    const m = s.trim().match(/^([\w-]+)(?::(FS|SS|FF|SF)([+-]\d+)?)?$/)
    if (!m) throw new Error(`Ungültige Abhängigkeit in Vorlage: ${s}`)
    return { predecessor_key: m[1], type: (m[2] ?? 'FS') as DependencyType, lag_days: m[3] ? Number(m[3]) : 0 }
  })
}

const P = 'phase' as const, T = 'task' as const, M = 'milestone' as const

const DHH_MASSIV: Row[] = DHH_MASSIV_V1

const EFH_MASSIV: Row[] = DHH_MASSIV.filter((r) => r[0] !== 'lueft' && r[0] !== 'lueft_ib').map((r) => (r[6] ? [...r.slice(0, 6), r[6].split(',').filter((d) => !d.startsWith('lueft')).join(','), ...r.slice(7)] as Row : r))

/** Holzständerbauweise: kein gemauerter Rohbau, Elemente werden vorgefertigt und gestellt */
const EFH_HOLZ: Row[] = [
  ['ph_vor', null, 'Vorbereitung & Baustelleneinrichtung', P, 0, null],
  ['ms_start', 'ph_vor', 'Baubeginn', M, 0, 'Bauleitung'],
  ['bse', 'ph_vor', 'Baustelleneinrichtung', T, 2, 'Baustelleneinrichtung', 'ms_start'],
  ['ph_erd', null, 'Erdarbeiten & Bodenplatte', P, 0, null],
  ['aushub', 'ph_erd', 'Baugrubenaushub', T, 3, 'Erdarbeiten', 'bse'],
  ['grund', 'ph_erd', 'Grundleitungen', T, 3, 'SHK', 'aushub'],
  ['bopl', 'ph_erd', 'Bodenplatte', T, 5, 'Rohbau', 'grund'],
  ['ms_bopl', 'ph_erd', 'Bodenplatte fertig', M, 0, 'Rohbau', 'bopl:FS+3'],
  ['ph_holz', null, 'Holzbau', P, 0, null],
  ['vorfert', 'ph_holz', 'Elementvorfertigung im Werk', T, 15, 'Zimmerer', 'ms_start'],
  ['stellen', 'ph_holz', 'Wände & Decken stellen', T, 3, 'Zimmerer', 'ms_bopl,vorfert'],
  ['dachstuhl', 'ph_holz', 'Dachstuhl', T, 2, 'Zimmerer', 'stellen'],
  ['ms_roh', 'ph_holz', 'Rohbau fertig', M, 0, 'Zimmerer', 'dachstuhl'],
  ['ph_dach', null, 'Dach & Hülle', P, 0, null],
  ['dachein', 'ph_dach', 'Dacheindeckung', T, 5, 'Dachdecker', 'ms_roh'],
  ['fenster', 'ph_dach', 'Fenster & Haustür', T, 3, 'Fenster', 'ms_roh'],
  ['ms_dicht', 'ph_dach', 'Gebäude dicht', M, 0, 'Bauleitung', 'dachein,fenster'],
  ['fassade', 'ph_dach', 'Fassade (Putz/Holz)', T, 10, 'Maler', 'ms_dicht:FS+5'],
  ['ph_inst', null, 'Installation', P, 0, null],
  ['el_roh', 'ph_inst', 'Elektro Rohinstallation', T, 6, 'Elektro', 'ms_dicht'],
  ['shk_roh', 'ph_inst', 'SHK Rohinstallation', T, 8, 'SHK', 'ms_dicht'],
  ['fbh', 'ph_inst', 'Fußbodenheizung', T, 3, 'SHK', 'shk_roh'],
  ['ph_ausbau', null, 'Innenausbau', P, 0, null],
  ['daemm', 'ph_ausbau', 'Dämmung & Dampfbremse', T, 4, 'Zimmerer', 'el_roh,shk_roh'],
  ['tb', 'ph_ausbau', 'Trockenbau Beplankung', T, 8, 'Trockenbau', 'daemm'],
  ['estrich', 'ph_ausbau', 'Estrich', T, 3, 'Estrich', 'tb,fbh'],
  ['ms_estrich', 'ph_ausbau', 'Estrich fertig', M, 0, 'Estrich', 'estrich'],
  ['trocknung', 'ph_ausbau', 'Trocknung Estrich', T, 15, 'Estrich', 'estrich'],
  ['fliesen', 'ph_ausbau', 'Fliesen', T, 6, 'Fliesen', 'trocknung'],
  ['maler', 'ph_ausbau', 'Malerarbeiten', T, 8, 'Maler', 'trocknung'],
  ['boden', 'ph_ausbau', 'Bodenbeläge', T, 4, 'Bodenleger', 'maler'],
  ['tueren', 'ph_ausbau', 'Innentüren', T, 2, 'Schreiner', 'boden'],
  ['ph_fertig', null, 'Fertigmontage', P, 0, null],
  ['el_fertig', 'ph_fertig', 'Elektro Fertigmontage', T, 4, 'Elektro', 'maler'],
  ['san_fertig', 'ph_fertig', 'Sanitär Fertigmontage', T, 4, 'SHK', 'fliesen,maler'],
  ['ms_bezug', 'ph_fertig', 'Bezugsfertigkeit', M, 0, 'Bauleitung', 'tueren,el_fertig,san_fertig'],
  ['ph_aussen', null, 'Außenanlagen', P, 0, null],
  ['aussen', 'ph_aussen', 'Außenanlagen', T, 8, 'Außenanlagen', 'fassade'],
  ['ph_abn', null, 'Abnahme & Übergabe', P, 0, null],
  ['maengel', 'ph_abn', 'Mängelbeseitigung', T, 4, 'Bauleitung', 'ms_bezug'],
  ['ms_abnahme', 'ph_abn', 'Abnahme', M, 0, 'Bauleitung', 'maengel,aussen'],
  ['ms_uebergabe', 'ph_abn', 'Übergabe', M, 0, 'Bauleitung', 'ms_abnahme:FS+2'],
]

const WOHNUNG_KERN: Row[] = [
  ['ph_vor', null, 'Vorbereitung', P, 0, null],
  ['ms_start', 'ph_vor', 'Baubeginn', M, 0, 'Bauleitung'],
  ['schutz', 'ph_vor', 'Schutzmaßnahmen & Baustelleneinrichtung', T, 1, 'Baustelleneinrichtung', 'ms_start'],
  ['ph_rueck', null, 'Rückbau', P, 0, null],
  ['entk', 'ph_rueck', 'Entkernung & Entsorgung', T, 4, 'Rohbau', 'schutz'],
  ['alt_inst', 'ph_rueck', 'Altinstallation demontieren', T, 2, 'SHK', 'entk:SS+1'],
  ['ms_entk', 'ph_rueck', 'Entkernung abgeschlossen', M, 0, 'Bauleitung', 'entk,alt_inst'],
  ['ph_roh', null, 'Rohinstallation', P, 0, null],
  ['wand', 'ph_roh', 'Neue Wände (Trockenbau-Ständer)', T, 3, 'Trockenbau', 'ms_entk'],
  ['el_roh', 'ph_roh', 'Elektro Rohinstallation', T, 4, 'Elektro', 'wand'],
  ['shk_roh', 'ph_roh', 'SHK Rohinstallation', T, 5, 'SHK', 'wand'],
  ['fenster', 'ph_roh', 'Fenstertausch', T, 2, 'Fenster', 'ms_entk'],
  ['ph_ausbau', null, 'Ausbau', P, 0, null],
  ['beplank', 'ph_ausbau', 'Beplankung & Spachtelung', T, 4, 'Trockenbau', 'el_roh,shk_roh'],
  ['putz', 'ph_ausbau', 'Putzausbesserung', T, 3, 'Innenputz', 'el_roh,shk_roh'],
  ['estrich', 'ph_ausbau', 'Estrich / Ausgleichsmasse', T, 2, 'Estrich', 'beplank,putz'],
  ['trocknung', 'ph_ausbau', 'Trocknung', T, 10, 'Estrich', 'estrich'],
  ['fliesen', 'ph_ausbau', 'Fliesen Bad & Küche', T, 5, 'Fliesen', 'trocknung'],
  ['maler', 'ph_ausbau', 'Malerarbeiten', T, 5, 'Maler', 'trocknung'],
  ['boden', 'ph_ausbau', 'Bodenbeläge', T, 3, 'Bodenleger', 'maler'],
  ['tueren', 'ph_ausbau', 'Innentüren', T, 1, 'Schreiner', 'boden'],
  ['ph_fertig', null, 'Fertigmontage', P, 0, null],
  ['el_fertig', 'ph_fertig', 'Elektro Fertigmontage', T, 2, 'Elektro', 'maler'],
  ['san_fertig', 'ph_fertig', 'Sanitär Fertigmontage', T, 3, 'SHK', 'fliesen'],
  ['kueche', 'ph_fertig', 'Küche', T, 2, 'Schreiner', 'el_fertig,san_fertig,boden'],
  ['reinig', 'ph_fertig', 'Endreinigung', T, 1, 'Bauleitung', 'kueche,tueren'],
  ['ms_abnahme', 'ph_fertig', 'Abnahme', M, 0, 'Bauleitung', 'reinig'],
  ['ms_uebergabe', 'ph_fertig', 'Übergabe', M, 0, 'Bauleitung', 'ms_abnahme:FS+1'],
]

const HAUS_KERN: Row[] = [
  ['ph_vor', null, 'Vorbereitung', P, 0, null],
  ['ms_start', 'ph_vor', 'Baubeginn', M, 0, 'Bauleitung'],
  ['bse', 'ph_vor', 'Baustelleneinrichtung & Gerüst', T, 2, 'Baustelleneinrichtung', 'ms_start'],
  ['ph_rueck', null, 'Rückbau & Entkernung', P, 0, null],
  ['entk', 'ph_rueck', 'Entkernung', T, 8, 'Rohbau', 'bse'],
  ['schadst', 'ph_rueck', 'Schadstoffentsorgung', T, 3, 'Rohbau', 'entk:SS+2'],
  ['ms_entk', 'ph_rueck', 'Entkernung abgeschlossen', M, 0, 'Bauleitung', 'entk,schadst'],
  ['ph_roh', null, 'Rohbau & Statik', P, 0, null],
  ['durchbr', 'ph_roh', 'Durchbrüche & Stahlträger', T, 5, 'Rohbau', 'ms_entk'],
  ['decke', 'ph_roh', 'Deckensanierung', T, 6, 'Rohbau', 'durchbr'],
  ['ph_dach', null, 'Dach & Hülle', P, 0, null],
  ['dach', 'ph_dach', 'Dachsanierung inkl. Dämmung', T, 12, 'Dachdecker', 'ms_entk'],
  ['fenster', 'ph_dach', 'Fenster & Haustür', T, 4, 'Fenster', 'decke'],
  ['ms_dicht', 'ph_dach', 'Gebäude dicht', M, 0, 'Bauleitung', 'dach,fenster'],
  ['wdvs', 'ph_dach', 'Fassadendämmung (WDVS)', T, 15, 'Maler', 'ms_dicht'],
  ['ph_inst', null, 'Haustechnik', P, 0, null],
  ['el_roh', 'ph_inst', 'Elektro Rohinstallation', T, 8, 'Elektro', 'ms_dicht'],
  ['shk_roh', 'ph_inst', 'SHK Rohinstallation', T, 10, 'SHK', 'ms_dicht'],
  ['heizung', 'ph_inst', 'Wärmepumpe / Heizzentrale', T, 5, 'SHK', 'shk_roh'],
  ['fbh', 'ph_inst', 'Fußbodenheizung', T, 4, 'SHK', 'shk_roh'],
  ['ph_ausbau', null, 'Innenausbau', P, 0, null],
  ['putz', 'ph_ausbau', 'Innenputz', T, 8, 'Innenputz', 'el_roh,shk_roh'],
  ['tb', 'ph_ausbau', 'Trockenbau', T, 8, 'Trockenbau', 'putz:SS+3'],
  ['estrich', 'ph_ausbau', 'Estrich', T, 3, 'Estrich', 'putz,fbh,tb'],
  ['ms_estrich', 'ph_ausbau', 'Estrich fertig', M, 0, 'Estrich', 'estrich'],
  ['trocknung', 'ph_ausbau', 'Trocknung Estrich', T, 20, 'Estrich', 'estrich'],
  ['fliesen', 'ph_ausbau', 'Fliesen', T, 8, 'Fliesen', 'trocknung'],
  ['maler', 'ph_ausbau', 'Malerarbeiten', T, 8, 'Maler', 'trocknung'],
  ['boden', 'ph_ausbau', 'Bodenbeläge', T, 5, 'Bodenleger', 'maler'],
  ['tueren', 'ph_ausbau', 'Innentüren & Treppe', T, 3, 'Schreiner', 'boden'],
  ['ph_fertig', null, 'Fertigmontage', P, 0, null],
  ['el_fertig', 'ph_fertig', 'Elektro Fertigmontage', T, 5, 'Elektro', 'maler'],
  ['san_fertig', 'ph_fertig', 'Sanitär Fertigmontage', T, 5, 'SHK', 'fliesen,maler'],
  ['heiz_ib', 'ph_fertig', 'Heizung Inbetriebnahme', T, 2, 'SHK', 'heizung,san_fertig'],
  ['ms_bezug', 'ph_fertig', 'Bezugsfertigkeit', M, 0, 'Bauleitung', 'tueren,el_fertig,san_fertig,heiz_ib'],
  ['ph_aussen', null, 'Außenanlagen', P, 0, null],
  ['aussen', 'ph_aussen', 'Außenanlagen & Zufahrt', T, 8, 'Außenanlagen', 'wdvs'],
  ['ph_abn', null, 'Abnahme & Übergabe', P, 0, null],
  ['maengel', 'ph_abn', 'Mängelbeseitigung', T, 5, 'Bauleitung', 'ms_bezug'],
  ['ms_abnahme', 'ph_abn', 'Abnahme', M, 0, 'Bauleitung', 'maengel,aussen'],
  ['ms_uebergabe', 'ph_abn', 'Übergabe', M, 0, 'Bauleitung', 'ms_abnahme:FS+3'],
]

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  { id: 'tpl_projektentwicklung', name: 'Neubauprojekt – Vorbereitung', description: 'Grundstück prüfen → Machbarkeit → Entwurf → Kalkulation → Finanzierung → Bauantrag → Ausschreibung → Vergabe → Baubeginn. Der Bauzeitenplan kann am Meilenstein „Baubeginn“ anschließen.', planning_kind: 'development', project_type: null, construction_method: null, rows: PROJEKTENTWICKLUNG },
  { id: 'tpl_gesamtprojekt', name: 'Gesamtprojekt Neubau (Entwicklung → Übergabe)', description: 'Phasenübergreifend: Projektentwicklung, Planung, Genehmigung, Kalkulation, Vergabe, Bauausführung (grob), Übergabe – Phasen können durch Arbeitspakete verfeinert werden.', planning_kind: 'development', project_type: null, construction_method: null, rows: GESAMTPROJEKT },
  { id: 'tpl_frei', name: 'Freier Projektplan (Grundgerüst)', description: 'Initiierung → Planung → Umsetzung → Abschluss mit Beispiel-Arbeitspaketen; für beliebige Vorhaben ohne Bauprojekt-Felder.', planning_kind: 'free', project_type: null, construction_method: null, rows: FREIER_PLAN },
  { id: 'tpl_efh_massiv', name: 'EFH Massiv Standard', description: 'Einfamilienhaus in Massivbauweise mit Keller, ca. 9–10 Monate Bauzeit.', planning_kind: 'construction', project_type: 'efh', construction_method: 'massiv', rows: EFH_MASSIV },
  { id: 'tpl_efh_holz', name: 'EFH Holzständer Standard', description: 'Einfamilienhaus in Holzständerbauweise, vorgefertigte Elemente, kurze Rohbauphase.', planning_kind: 'construction', project_type: 'efh', construction_method: 'holzstaender', rows: EFH_HOLZ },
  { id: 'tpl_dhh_massiv', name: 'DHH Massiv', description: 'Doppelhaushälfte massiv mit Keller inkl. Lüftungsanlage – Rohbau je Geschoss mit Decken-Arbeitsschritten, Gewerke mehrfach im Ablauf, Voraussetzungen.', planning_kind: 'construction', project_type: 'dhh', construction_method: 'massiv', rows: DHH_MASSIV },
  { id: 'tpl_whg_kern', name: 'Wohnung Kernsanierung', description: 'Komplette Kernsanierung einer Wohnung im Bestand, ca. 10–12 Wochen.', planning_kind: 'construction', project_type: 'wohnung_sanierung', construction_method: 'individuell', rows: WOHNUNG_KERN },
  { id: 'tpl_haus_kern', name: 'Haus Kernsanierung', description: 'Energetische Kernsanierung eines Bestandshauses inkl. Dach, Fassade und Haustechnik.', planning_kind: 'construction', project_type: 'haus_sanierung', construction_method: 'individuell', rows: HAUS_KERN },
]
