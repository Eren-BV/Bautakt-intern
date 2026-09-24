/**
 * Beispiel-Prozess im BuildFlow-Exportformat (Angebots- und Vergabeprozess) - für Demo,
 * „Beispiel laden“ im Import-Dialog und Tests. Entspricht dem, was BuildFlow unter
 * „Exportieren“ als prozesse.json liefert (ein Element des Arrays).
 */

import type { BuildFlowProcess } from './types.ts'

export const SAMPLE_BUILDFLOW_PROCESS: BuildFlowProcess = {
  id: 'bf_angebot_vergabe',
  name: 'Angebots- & Vergabeprozess',
  category: 'Vertrieb',
  description: 'Von der Anfrage bis zur Vergabe: Anfrage prüfen, Aufmaß, Kalkulation, Angebot, Verhandlung, Vertrag, Übergabe an die Bauleitung.',
  version: 3,
  templateVersion: '1.2',
  roles: [
    { id: 'r_vertrieb', name: 'Vertrieb' },
    { id: 'r_kalk', name: 'Kalkulation' },
    { id: 'r_gf', name: 'Geschäftsführung' },
    { id: 'r_bl', name: 'Bauleitung' },
  ],
  nodes: [
    { id: 'n_start', kind: 'start', name: 'Anfrage eingegangen' },
    { id: 'n_pruef', kind: 'aufgabe', name: 'Anfrage prüfen & qualifizieren', roleId: 'r_vertrieb', area: 'Anfrage', duration: { value: 2, unit: 'tage' }, description: 'Passt das Projekt zu uns? Budget, Region, Termin.' },
    { id: 'n_ent1', kind: 'entscheidung', name: 'Angebot abgeben?', roleId: 'r_gf', area: 'Anfrage', condition: 'Projekt passt zu Kapazität und Strategie?' },
    { id: 'n_aufmass', kind: 'aufgabe', name: 'Ortstermin & Aufmaß', roleId: 'r_vertrieb', area: 'Kalkulation', duration: { value: 1, unit: 'tage' } },
    { id: 'n_mengen', kind: 'aufgabe', name: 'Mengen ermitteln', roleId: 'r_kalk', area: 'Kalkulation', duration: { value: 3, unit: 'tage' } },
    { id: 'n_nu', kind: 'aufgabe', name: 'NU-Preise einholen', roleId: 'r_kalk', area: 'Kalkulation', duration: { value: 2, unit: 'wochen' } },
    { id: 'n_kalk', kind: 'aufgabe', name: 'Kalkulation erstellen', roleId: 'r_kalk', area: 'Kalkulation', duration: { value: 4, unit: 'tage' } },
    { id: 'n_freigabe', kind: 'checkliste', name: 'Kalkulation freigeben (4-Augen)', roleId: 'r_gf', area: 'Kalkulation', duration: { value: 4, unit: 'std' } },
    { id: 'n_angebot', kind: 'dokument', name: 'Angebot erstellen & versenden', roleId: 'r_vertrieb', area: 'Angebot', duration: { value: 1, unit: 'tage' } },
    { id: 'n_wait', kind: 'warten', name: 'Bedenkzeit Kunde', wait: { kind: 'dauer', duration: { value: 2, unit: 'wochen' } } },
    { id: 'n_verh', kind: 'aufgabe', name: 'Verhandlung', roleId: 'r_gf', area: 'Angebot', duration: { value: 3, unit: 'tage' } },
    { id: 'n_wait2', kind: 'warten', name: 'Auftragserteilung', wait: { kind: 'ereignis', event: 'Schriftliche Auftragserteilung des Kunden' } },
    { id: 'n_vertrag', kind: 'dokument', name: 'Bauvertrag erstellen', roleId: 'r_gf', area: 'Vergabe', duration: { value: 2, unit: 'tage' } },
    { id: 'n_nu_vergabe', kind: 'aufgabe', name: 'Nachunternehmer vergeben', roleId: 'r_kalk', area: 'Vergabe', duration: { value: 2, unit: 'wochen' } },
    { id: 'n_uebergabe', kind: 'aufgabe', name: 'Übergabe an Bauleitung', roleId: 'r_bl', area: 'Vergabe', duration: { value: 1, unit: 'tage' }, scheduleAnchor: 'projektende', leadTime: { value: 1, unit: 'wochen' } },
    { id: 'n_benachr', kind: 'benachrichtigung', name: 'Team informieren', roleId: 'r_bl', area: 'Vergabe', duration: { value: 1, unit: 'std' } },
    { id: 'n_ende', kind: 'ende', name: 'Baubeginn' },
  ],
  edges: [
    { id: 'e1', from: 'n_start', to: 'n_pruef' },
    { id: 'e2', from: 'n_pruef', to: 'n_ent1' },
    { id: 'e3', from: 'n_ent1', to: 'n_aufmass', label: 'JA' },
    { id: 'e4', from: 'n_aufmass', to: 'n_mengen' },
    { id: 'e5', from: 'n_mengen', to: 'n_nu' },
    { id: 'e6', from: 'n_mengen', to: 'n_kalk' },
    { id: 'e7', from: 'n_nu', to: 'n_kalk' },
    { id: 'e8', from: 'n_kalk', to: 'n_freigabe' },
    { id: 'e9', from: 'n_freigabe', to: 'n_angebot' },
    { id: 'e10', from: 'n_angebot', to: 'n_wait' },
    { id: 'e11', from: 'n_wait', to: 'n_verh' },
    { id: 'e12', from: 'n_verh', to: 'n_wait2' },
    { id: 'e13', from: 'n_wait2', to: 'n_vertrag' },
    { id: 'e14', from: 'n_vertrag', to: 'n_nu_vergabe' },
    { id: 'e15', from: 'n_nu_vergabe', to: 'n_uebergabe' },
    { id: 'e16', from: 'n_uebergabe', to: 'n_benachr' },
    { id: 'e17', from: 'n_benachr', to: 'n_ende' },
  ],
  updatedAt: '2026-09-01T10:00:00.000Z',
}

/** Geänderte Version 1.3 desselben Prozesses (für die Demo „BuildFlow wurde geändert“) */
export const SAMPLE_BUILDFLOW_PROCESS_V2: BuildFlowProcess = {
  ...SAMPLE_BUILDFLOW_PROCESS,
  version: 4,
  templateVersion: '1.3',
  updatedAt: '2026-09-15T10:00:00.000Z',
  nodes: SAMPLE_BUILDFLOW_PROCESS.nodes
    .filter((n) => n.id !== 'n_benachr')
    .map((n) => (n.id === 'n_nu' ? { ...n, duration: { value: 3, unit: 'wochen' as const } } : n))
    .concat([
      { id: 'n_risiko', kind: 'checkliste', name: 'Risikobewertung Projekt', roleId: 'r_gf', area: 'Anfrage', duration: { value: 1, unit: 'tage' } },
      { id: 'n_bonitaet', kind: 'aufgabe', name: 'Bonitätsprüfung Kunde', roleId: 'r_gf', area: 'Angebot', duration: { value: 2, unit: 'tage' } },
      { id: 'n_kickoff', kind: 'aufgabe', name: 'Kick-off Baustelle', roleId: 'r_bl', area: 'Vergabe', duration: { value: 1, unit: 'tage' } },
    ]),
  edges: SAMPLE_BUILDFLOW_PROCESS.edges
    .filter((e) => e.id !== 'e16' && e.id !== 'e17' && e.id !== 'e2')
    .concat([
      { id: 'e2a', from: 'n_pruef', to: 'n_risiko' },
      { id: 'e2b', from: 'n_risiko', to: 'n_ent1' },
      { id: 'e18', from: 'n_freigabe', to: 'n_bonitaet' },
      { id: 'e19', from: 'n_bonitaet', to: 'n_angebot' },
      { id: 'e20', from: 'n_uebergabe', to: 'n_kickoff' },
      { id: 'e21', from: 'n_kickoff', to: 'n_ende' },
    ]),
}
