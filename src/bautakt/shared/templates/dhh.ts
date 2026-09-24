/**
 * DHH/EFH Massiv in Planungstiefe V1: Bauphase → Geschoss/Gruppe → Arbeit → Unterarbeit.
 * Gewerke tauchen mehrfach auf (Elektro: Fundamenterder, Leerrohre je Decke, Rohinstallation
 * je Geschoss, Dosen freilegen, Fertigmontage). Bauabschnitte: Keller, EG, OG, Dach, Außen.
 * Zeile: [key, parent, name, type, dauerAT, gewerk, abhängigkeiten, bauabschnitt, voraussetzungen]
 */

import type { TaskType, TemplateConstraint } from '../types.ts'

type Row = [key: string, parent: string | null, name: string, type: TaskType, duration: number, trade: string | null, deps?: string, section?: string | null, constraints?: TemplateConstraint[]]
const P = 'phase' as const, G = 'group' as const, T = 'task' as const, M = 'milestone' as const
const c = (type: TemplateConstraint['type'], title: string): TemplateConstraint => ({ type, title })

export const DHH_SECTIONS = ['Keller', 'EG', 'OG', 'Dach', 'Außen']

export const DHH_MASSIV_V1: Row[] = [
  ['ph_vor', null, 'Vorbereitung & Baustelleneinrichtung', P, 0, null],
  ['ms_start', 'ph_vor', 'Baubeginn', M, 0, 'Bauleitung', undefined, null, [c('approval', 'Baugenehmigung liegt vor'), c('planning', 'Ausführungspläne Rohbau freigegeben')]],
  ['bse', 'ph_vor', 'Baustelleneinrichtung', T, 2, 'Baustelleneinrichtung', 'ms_start', null, [c('authority', 'Verkehrsrechtliche Anordnung Container/Kran')]],
  ['abst', 'ph_vor', 'Abstecken & Schnurgerüst', T, 1, 'Erdarbeiten', 'bse'],

  ['ph_erd', null, 'Erdarbeiten & Fundament', P, 0, null],
  ['aushub', 'ph_erd', 'Baugrubenaushub', T, 4, 'Erdarbeiten', 'abst', 'Keller'],
  ['sauber', 'ph_erd', 'Sauberkeitsschicht & Drainage', T, 2, 'Erdarbeiten', 'aushub', 'Keller'],
  ['grund', 'ph_erd', 'Grundleitungen verlegen', T, 3, 'SHK', 'sauber', 'Keller'],
  ['fund', 'ph_erd', 'Streifenfundamente', T, 4, 'Rohbau', 'grund', 'Keller'],
  ['bopl', 'ph_erd', 'Bodenplatte', G, 0, null, undefined, 'Keller'],
  ['bopl_sch', 'bopl', 'Schalung Bodenplatte', T, 1, 'Rohbau', 'fund', 'Keller'],
  ['bopl_bew', 'bopl', 'Bewehrung Bodenplatte', T, 1, 'Rohbau', 'bopl_sch', 'Keller'],
  ['bopl_el', 'bopl', 'Fundamenterder (Elektro)', T, 1, 'Elektro', 'bopl_sch', 'Keller'],
  ['bopl_bet', 'bopl', 'Betonage Bodenplatte', T, 1, 'Rohbau', 'bopl_bew,bopl_el', 'Keller', [c('material', 'Beton bestellt (Lieferschein)')]],
  ['ms_bopl', 'ph_erd', 'Bodenplatte fertig', M, 0, 'Rohbau', 'bopl_bet:FS+2', 'Keller'],

  ['ph_kg', null, 'Keller', P, 0, null, undefined, 'Keller'],
  ['kg_wand', 'ph_kg', 'Kellerwände mauern/betonieren', T, 8, 'Rohbau', 'ms_bopl', 'Keller'],
  ['kg_decke', 'ph_kg', 'Kellerdecke', G, 0, null, undefined, 'Keller'],
  ['kg_decke_sch', 'kg_decke', 'Schalung Kellerdecke', T, 2, 'Rohbau', 'kg_wand', 'Keller'],
  ['kg_decke_bew', 'kg_decke', 'Bewehrung Kellerdecke', T, 1, 'Rohbau', 'kg_decke_sch', 'Keller'],
  ['kg_decke_el', 'kg_decke', 'Elektro-Leerrohre Kellerdecke', T, 1, 'Elektro', 'kg_decke_sch', 'Keller'],
  ['kg_decke_bet', 'kg_decke', 'Betonage Kellerdecke', T, 1, 'Rohbau', 'kg_decke_bew,kg_decke_el', 'Keller'],
  ['kg_abd', 'ph_kg', 'Abdichtung & Perimeterdämmung', T, 3, 'Rohbau', 'kg_decke_bet', 'Keller'],
  ['kg_verf', 'ph_kg', 'Arbeitsraum verfüllen', T, 2, 'Erdarbeiten', 'kg_abd', 'Keller'],

  ['ph_roh', null, 'Rohbau', P, 0, null],
  ['roh_eg', 'ph_roh', 'Erdgeschoss', G, 0, null, undefined, 'EG'],
  ['eg_wand', 'roh_eg', 'Wände EG mauern', T, 8, 'Rohbau', 'kg_decke_bet:FS+3', 'EG'],
  ['eg_decke', 'roh_eg', 'Decke EG', G, 0, null, undefined, 'EG'],
  ['eg_decke_sch', 'eg_decke', 'Schalung Decke EG', T, 2, 'Rohbau', 'eg_wand', 'EG'],
  ['eg_decke_bew', 'eg_decke', 'Bewehrung Decke EG', T, 1, 'Rohbau', 'eg_decke_sch', 'EG'],
  ['eg_decke_el', 'eg_decke', 'Elektro-Leerrohre Decke EG', T, 1, 'Elektro', 'eg_decke_sch', 'EG', [c('planning', 'Elektroplan Decke EG freigegeben')]],
  ['eg_decke_bet', 'eg_decke', 'Betonage Decke EG', T, 1, 'Rohbau', 'eg_decke_bew,eg_decke_el', 'EG'],
  ['roh_og', 'ph_roh', 'Obergeschoss', G, 0, null, undefined, 'OG'],
  ['og_wand', 'roh_og', 'Wände OG mauern', T, 7, 'Rohbau', 'eg_decke_bet:FS+2', 'OG'],
  ['og_decke', 'roh_og', 'Decke OG', G, 0, null, undefined, 'OG'],
  ['og_decke_sch', 'og_decke', 'Schalung Decke OG', T, 2, 'Rohbau', 'og_wand', 'OG'],
  ['og_decke_bew', 'og_decke', 'Bewehrung & Ringanker OG', T, 1, 'Rohbau', 'og_decke_sch', 'OG'],
  ['og_decke_el', 'og_decke', 'Elektro-Leerrohre Decke OG', T, 1, 'Elektro', 'og_decke_sch', 'OG'],
  ['og_decke_bet', 'og_decke', 'Betonage Decke OG', T, 1, 'Rohbau', 'og_decke_bew,og_decke_el', 'OG'],
  ['giebel', 'roh_og', 'Giebel & Kniestock mauern', T, 3, 'Rohbau', 'og_decke_bet:FS+2', 'OG'],
  ['ms_roh', 'ph_roh', 'Rohbau fertig', M, 0, 'Rohbau', 'giebel'],

  ['ph_dach', null, 'Dach', P, 0, null, undefined, 'Dach'],
  ['dachstuhl', 'ph_dach', 'Dachstuhl aufstellen', T, 4, 'Zimmerer', 'ms_roh', 'Dach', [c('material', 'Abbund geliefert')]],
  ['dachein', 'ph_dach', 'Dacheindeckung inkl. Unterspannbahn', T, 6, 'Dachdecker', 'dachstuhl', 'Dach'],
  ['spengler', 'ph_dach', 'Spenglerarbeiten & Dachrinnen', T, 3, 'Dachdecker', 'dachein:SS+3', 'Dach'],
  ['dach_el', 'ph_dach', 'Elektro: Dachdurchführungen & PV-Vorbereitung', T, 1, 'Elektro', 'dachein:SS+2', 'Dach'],

  ['ph_huelle', null, 'Gebäudehülle', P, 0, null],
  ['fenster', 'ph_huelle', 'Fenster & Haustür montieren', T, 4, 'Fenster', 'ms_roh:FS+5', null, [c('material', 'Fensterelemente geliefert')]],
  ['ms_dicht', 'ph_huelle', 'Gebäude dicht', M, 0, 'Bauleitung', 'fenster,dachein'],
  ['wdvs', 'ph_huelle', 'Fassade / WDVS', T, 12, 'Maler', 'ms_dicht:FS+10', 'Außen', [c('equipment', 'Gerüst gestellt')]],

  ['ph_rohinst', null, 'Rohinstallation', P, 0, null],
  ['el_roh_kg', 'ph_rohinst', 'Elektro Rohinstallation KG', T, 2, 'Elektro', 'ms_dicht', 'Keller'],
  ['el_roh_eg', 'ph_rohinst', 'Elektro Rohinstallation EG', T, 4, 'Elektro', 'el_roh_kg', 'EG'],
  ['el_roh_og', 'ph_rohinst', 'Elektro Rohinstallation OG', T, 4, 'Elektro', 'el_roh_eg', 'OG'],
  ['shk_roh_kg', 'ph_rohinst', 'SHK Rohinstallation KG / Heizzentrale', T, 4, 'SHK', 'ms_dicht', 'Keller', [c('planning', 'Heizlastberechnung liegt vor')]],
  ['shk_roh_eg', 'ph_rohinst', 'SHK Rohinstallation EG', T, 4, 'SHK', 'shk_roh_kg', 'EG'],
  ['shk_roh_og', 'ph_rohinst', 'SHK Rohinstallation OG', T, 4, 'SHK', 'shk_roh_eg', 'OG'],
  ['lueft', 'ph_rohinst', 'Lüftungsanlage Rohmontage', T, 4, 'SHK', 'shk_roh_eg:SS+2'],
  ['fbh_eg', 'ph_rohinst', 'Fußbodenheizung EG', T, 2, 'SHK', 'shk_roh_og', 'EG'],
  ['fbh_og', 'ph_rohinst', 'Fußbodenheizung OG', T, 2, 'SHK', 'fbh_eg', 'OG'],

  ['ph_ausbau1', null, 'Innenausbau I', P, 0, null],
  ['putz_kg', 'ph_ausbau1', 'Kellerputz', T, 2, 'Innenputz', 'el_roh_kg,shk_roh_kg', 'Keller'],
  ['putz_eg', 'ph_ausbau1', 'Innenputz EG', T, 5, 'Innenputz', 'el_roh_eg,shk_roh_eg,putz_kg', 'EG'],
  ['putz_og', 'ph_ausbau1', 'Innenputz OG', T, 4, 'Innenputz', 'el_roh_og,shk_roh_og,putz_eg', 'OG'],
  ['tb_dg', 'ph_ausbau1', 'Trockenbau Dachschrägen & Decken DG', T, 6, 'Trockenbau', 'putz_og:SS+2', 'OG'],
  ['estrich', 'ph_ausbau1', 'Estrich einbringen', T, 3, 'Estrich', 'putz_og:FS+3,fbh_og', null, [c('predecessor', 'Druckprobe Fußbodenheizung protokolliert')]],
  ['ms_estrich', 'ph_ausbau1', 'Estrich fertig', M, 0, 'Estrich', 'estrich'],
  ['trocknung', 'ph_ausbau1', 'Trocknung Estrich', T, 20, 'Estrich', 'estrich'],

  ['ph_ausbau2', null, 'Innenausbau II', P, 0, null],
  ['tb_waende', 'ph_ausbau2', 'Trockenbau Wände & Vorsatzschalen', T, 5, 'Trockenbau', 'trocknung:SS+5'],
  ['abdicht', 'ph_ausbau2', 'Abdichtung Bäder', T, 1, 'Fliesen', 'trocknung', 'OG', [c('approval', 'Abdichtung durch Bauleitung abgenommen')]],
  ['fliesen_wand', 'ph_ausbau2', 'Wandfliesen Bäder', T, 5, 'Fliesen', 'abdicht', 'OG', [c('material', 'Fliesen geliefert'), c('approval', 'Verlegemuster vom Bauherrn freigegeben')]],
  ['fliesen_boden', 'ph_ausbau2', 'Bodenfliesen EG & Bäder', T, 4, 'Fliesen', 'fliesen_wand', 'EG'],
  ['maler1', 'ph_ausbau2', 'Maler: Spachteln & Grundierung', T, 5, 'Maler', 'trocknung:FS+2,tb_waende'],
  ['el_dosen', 'ph_ausbau2', 'Elektro: Dosen freilegen & Schalterprogramm', T, 1, 'Elektro', 'maler1'],
  ['maler2', 'ph_ausbau2', 'Maler: Endanstrich', T, 4, 'Maler', 'maler1'],
  ['boden', 'ph_ausbau2', 'Bodenbeläge (Parkett/Vinyl)', T, 5, 'Bodenleger', 'maler2', null, [c('material', 'Parkett akklimatisiert (48 h)')]],
  ['tueren', 'ph_ausbau2', 'Innentüren montieren', T, 3, 'Schreiner', 'boden'],
  ['treppe', 'ph_ausbau2', 'Treppe montieren', T, 2, 'Schreiner', 'maler2'],

  ['ph_fertig', null, 'Fertigmontage', P, 0, null],
  ['el_fertig', 'ph_fertig', 'Elektro Fertigmontage', T, 5, 'Elektro', 'maler2,el_dosen'],
  ['san_fertig', 'ph_fertig', 'Sanitär Fertigmontage', T, 5, 'SHK', 'fliesen_boden,maler2', null, [c('material', 'Sanitärobjekte geliefert')]],
  ['heiz_ib', 'ph_fertig', 'Heizung Inbetriebnahme', T, 2, 'SHK', 'san_fertig'],
  ['lueft_ib', 'ph_fertig', 'Lüftung Inbetriebnahme & Einregulierung', T, 1, 'SHK', 'heiz_ib,el_fertig'],
  ['kueche', 'ph_fertig', 'Küchenmontage', T, 2, 'Schreiner', 'el_fertig,san_fertig'],
  ['ms_bezug', 'ph_fertig', 'Bezugsfertigkeit', M, 0, 'Bauleitung', 'tueren,el_fertig,san_fertig,heiz_ib,lueft_ib'],

  ['ph_aussen', null, 'Außenanlagen', P, 0, null, undefined, 'Außen'],
  ['aussen_erd', 'ph_aussen', 'Geländemodellierung', T, 3, 'Außenanlagen', 'wdvs', 'Außen'],
  ['pflaster', 'ph_aussen', 'Pflaster & Wege', T, 6, 'Außenanlagen', 'aussen_erd', 'Außen'],
  ['terrasse', 'ph_aussen', 'Terrasse', T, 3, 'Außenanlagen', 'pflaster:SS+3', 'Außen'],
  ['garten', 'ph_aussen', 'Garten & Bepflanzung', T, 3, 'Außenanlagen', 'pflaster', 'Außen'],
  ['zaun', 'ph_aussen', 'Zaun & Carport', T, 2, 'Außenanlagen', 'garten:SS+1', 'Außen'],

  ['ph_abn', null, 'Abnahme & Übergabe', P, 0, null],
  ['reinig', 'ph_abn', 'Bauendreinigung', T, 2, 'Bauleitung', 'ms_bezug'],
  ['maengel', 'ph_abn', 'Mängelbeseitigung', T, 5, 'Bauleitung', 'reinig'],
  ['ms_abnahme', 'ph_abn', 'Abnahme', M, 0, 'Bauleitung', 'maengel,garten,zaun'],
  ['ms_uebergabe', 'ph_abn', 'Übergabe', M, 0, 'Bauleitung', 'ms_abnahme:FS+3'],
]

/** Mengen/Leistungswerte für die Demo (Menge, Einheit, Leistungswert/AT) */
export const DHH_QUANTITIES: Record<string, { quantity: number; unit: string; rate: number }> = {
  putz_eg: { quantity: 520, unit: 'm²', rate: 110 },
  putz_og: { quantity: 440, unit: 'm²', rate: 110 },
  estrich: { quantity: 280, unit: 'm²', rate: 100 },
  fliesen_wand: { quantity: 95, unit: 'm²', rate: 20 },
  fliesen_boden: { quantity: 120, unit: 'm²', rate: 30 },
  boden: { quantity: 165, unit: 'm²', rate: 35 },
  eg_wand: { quantity: 148, unit: 'm²', rate: 20 },
  og_wand: { quantity: 132, unit: 'm²', rate: 20 },
  wdvs: { quantity: 310, unit: 'm²', rate: 28 },
  pflaster: { quantity: 85, unit: 'm²', rate: 15 },
}

export interface BuiltinWorkPackage {
  id: string
  name: string
  description: string
  rows: Row[]
}

export const BUILTIN_WORK_PACKAGES: BuiltinWorkPackage[] = [
  {
    id: 'wp_bad', name: 'Bad komplett', description: 'Kompletter Badausbau von der Rohinstallation bis „Bad fertig“ inkl. Abdichtung und Fliesen.',
    rows: [
      ['g', null, 'Bad komplett', G, 0, null],
      ['shk_roh', 'g', 'SHK Rohinstallation Bad', T, 3, 'SHK'],
      ['el_roh', 'g', 'Elektro Rohinstallation Bad', T, 1, 'Elektro', 'shk_roh'],
      ['tb', 'g', 'Trockenbau Vorwand & Decke', T, 2, 'Trockenbau', 'el_roh'],
      ['abd', 'g', 'Abdichtung', T, 1, 'Fliesen', 'tb', null, [c('approval', 'Abdichtung abgenommen')]],
      ['fl_w', 'g', 'Wandfliesen', T, 3, 'Fliesen', 'abd:FS+1', null, [c('material', 'Fliesen geliefert')]],
      ['fl_b', 'g', 'Bodenfliesen', T, 2, 'Fliesen', 'fl_w'],
      ['maler', 'g', 'Maler Bad', T, 1, 'Maler', 'fl_b'],
      ['el_f', 'g', 'Elektro Fertigmontage Bad', T, 1, 'Elektro', 'maler'],
      ['shk_f', 'g', 'SHK Fertigmontage Bad', T, 2, 'SHK', 'el_f', null, [c('material', 'Sanitärobjekte geliefert')]],
      ['ms', 'g', 'Bad fertig', M, 0, 'Bauleitung', 'shk_f'],
    ],
  },
  {
    id: 'wp_rohbau_geschoss', name: 'Rohbau Geschoss', description: 'Wände mauern, Decke schalen/bewehren, Elektro-Leerrohre, Betonage, Ausschalen.',
    rows: [
      ['g', null, 'Rohbau Geschoss', G, 0, null],
      ['wand', 'g', 'Wände mauern', T, 7, 'Rohbau'],
      ['decke', 'g', 'Decke', G, 0, null],
      ['sch', 'decke', 'Schalung Decke', T, 2, 'Rohbau', 'wand'],
      ['bew', 'decke', 'Bewehrung Decke', T, 1, 'Rohbau', 'sch'],
      ['el', 'decke', 'Elektro-Leerrohre Decke', T, 1, 'Elektro', 'sch'],
      ['bet', 'decke', 'Betonage Decke', T, 1, 'Rohbau', 'bew,el', null, [c('material', 'Beton bestellt')]],
      ['aus', 'g', 'Ausschalen', T, 1, 'Rohbau', 'bet:FS+3'],
    ],
  },
  {
    id: 'wp_dach', name: 'Dach', description: 'Dachstuhl, Lattung, Eindeckung, Spengler bis „Dach dicht“.',
    rows: [
      ['g', null, 'Dach', G, 0, null],
      ['stuhl', 'g', 'Dachstuhl aufstellen', T, 4, 'Zimmerer', undefined, null, [c('material', 'Abbund geliefert')]],
      ['latt', 'g', 'Unterspannbahn & Lattung', T, 2, 'Dachdecker', 'stuhl'],
      ['deck', 'g', 'Eindeckung', T, 4, 'Dachdecker', 'latt'],
      ['speng', 'g', 'Spenglerarbeiten', T, 3, 'Dachdecker', 'deck:SS+2'],
      ['ms', 'g', 'Dach dicht', M, 0, 'Bauleitung', 'deck,speng'],
    ],
  },
  {
    id: 'wp_el_roh', name: 'Elektro Rohinstallation', description: 'Schlitze, Leerrohre und Dosen, Verteiler, Kabelzug.',
    rows: [
      ['g', null, 'Elektro Rohinstallation', G, 0, null],
      ['schlitz', 'g', 'Schlitze & Durchbrüche', T, 2, 'Elektro'],
      ['rohr', 'g', 'Leerrohre & Dosen setzen', T, 3, 'Elektro', 'schlitz'],
      ['vert', 'g', 'Verteilerkasten setzen', T, 1, 'Elektro', 'rohr:SS+1'],
      ['kabel', 'g', 'Kabelzug', T, 2, 'Elektro', 'rohr,vert'],
      ['ms', 'g', 'Rohinstallation Elektro fertig', M, 0, 'Elektro', 'kabel'],
    ],
  },
  {
    id: 'wp_innenausbau', name: 'Innenausbau', description: 'Innenputz, Estrich, Trocknung, Trockenbau, Maler, Boden, Türen.',
    rows: [
      ['g', null, 'Innenausbau', G, 0, null],
      ['putz', 'g', 'Innenputz', T, 6, 'Innenputz'],
      ['estrich', 'g', 'Estrich', T, 2, 'Estrich', 'putz:FS+3'],
      ['trock', 'g', 'Trocknung Estrich', T, 20, 'Estrich', 'estrich'],
      ['tb', 'g', 'Trockenbau', T, 4, 'Trockenbau', 'trock:SS+5'],
      ['maler', 'g', 'Malerarbeiten', T, 6, 'Maler', 'trock,tb'],
      ['boden', 'g', 'Bodenbeläge', T, 4, 'Bodenleger', 'maler'],
      ['tueren', 'g', 'Innentüren', T, 2, 'Schreiner', 'boden'],
    ],
  },
]
