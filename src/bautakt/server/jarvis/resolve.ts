/**
 * Unscharfe Namenssuche für Projekte, Vorgänge, Personen und Firmen. Gesprochene Eingaben
 * sind ungenau (Meier/Maier, „EG“/„Erdgeschoss“, Tippfehler der Spracherkennung) - daher
 * Normalisierung, Abkürzungen, Kölner Phonetik und Editierdistanz.
 */

const ABBREVIATIONS: Record<string, string> = {
  eg: 'erdgeschoss',
  og: 'obergeschoss',
  ug: 'untergeschoss',
  dg: 'dachgeschoss',
  kg: 'keller',
  tg: 'tiefgarage',
  nu: 'nachunternehmer',
  bv: 'bauvorhaben',
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Füllwörter gesprochener Sätze („das Spachteln vom Maler“) - zählen bei der Suche nicht. */
const STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer',
  'vom', 'von', 'im', 'in', 'am', 'an', 'auf', 'bei', 'beim', 'zum', 'zur', 'zu', 'und', 'mit', 'fuer', 'fur',
])

function tokens(s: string): string[] {
  const all = normalize(s).split(' ').filter(Boolean)
  const meaningful = all.filter((t) => !STOPWORDS.has(t))
  return (meaningful.length ? meaningful : all).map((t) => ABBREVIATIONS[t] ?? t)
}

const inSet = (ch: string, set: string) => ch !== '' && set.includes(ch)

/** Kölner Phonetik: gleich klingende deutsche Wörter erhalten denselben Code. */
export function koelner(word: string): string {
  const s = word.toUpperCase().replace(/Ä/g, 'A').replace(/Ö/g, 'O').replace(/Ü/g, 'U').replace(/ß/g, 'S').replace(/[^A-Z]/g, '')
  let codes = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    const prev = s[i - 1] ?? ''
    const next = s[i + 1] ?? ''
    if (inSet(c, 'AEIJOUY')) codes += '0'
    else if (c === 'H') continue
    else if (c === 'B') codes += '1'
    else if (c === 'P') codes += next === 'H' ? '3' : '1'
    else if (c === 'D' || c === 'T') codes += inSet(next, 'CSZ') ? '8' : '2'
    else if (inSet(c, 'FVW')) codes += '3'
    else if (inSet(c, 'GKQ')) codes += '4'
    else if (c === 'C') {
      if (i === 0) codes += inSet(next, 'AHKLOQRUX') ? '4' : '8'
      else codes += inSet(prev, 'SZ') ? '8' : inSet(next, 'AHKOQUX') ? '4' : '8'
    } else if (c === 'X') codes += inSet(prev, 'CKQ') ? '8' : '48'
    else if (c === 'L') codes += '5'
    else if (c === 'M' || c === 'N') codes += '6'
    else if (c === 'R') codes += '7'
    else if (c === 'S' || c === 'Z') codes += '8'
  }
  let collapsed = ''
  for (const ch of codes) if (ch !== collapsed[collapsed.length - 1]) collapsed += ch
  return collapsed.charAt(0) + collapsed.slice(1).replace(/0/g, '')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]!
}

/** Ähnlichkeit 0…1 zwischen Suchbegriff und Text. */
export function similarity(query: string, text: string): number {
  const q = normalize(query)
  const t = normalize(text)
  if (!q || !t) return 0
  if (q === t) return 1
  if (t.startsWith(q)) return 0.92
  const qt = tokens(query)
  const tt = tokens(text)
  if (!qt.length || !tt.length) return 0
  const tset = new Set(tt)
  if (qt.every((w) => tset.has(w) || (w.length >= 3 && tt.some((x) => x.startsWith(w))))) return 0.88
  let sum = 0
  for (const w of qt) {
    let best = 0
    for (const x of tt) {
      if (x === w) {
        best = 1
        break
      }
      if (w.length >= 3 && x.startsWith(w)) best = Math.max(best, 0.9)
      // Andere Wortform („Spachteln“ ↔ „Spachtelarbeiten“, „Fliesen“ ↔ „Fliesenleger“)
      const st = stem(w)
      if (st.length >= 4 && st !== w && x.startsWith(st)) best = Math.max(best, 0.85)
      // Teil eines zusammengesetzten Worts („Belag“ in „Bodenbelag“)
      if (w.length >= 4 && x.includes(w)) best = Math.max(best, 0.8)
      if (w.length >= 3 && x.length >= 3 && koelner(w) === koelner(x)) best = Math.max(best, 0.82)
      const rel = 1 - levenshtein(w, x) / Math.max(w.length, x.length)
      if (rel >= 0.7) best = Math.max(best, rel * 0.85)
    }
    // Zusammengesetztes Wort aus mehreren Begriffen des Kandidaten („Bauantragsunterlagen“)
    if (best < 0.88 && w.length >= 8) best = Math.max(best, compoundScore(w, tt))
    sum += best
  }
  return (sum / qt.length) * 0.85
}

/** Grobe deutsche Wortstammbildung: typische Endungen abschneiden. */
function stem(w: string): string {
  const s = w.replace(/(ern|en|er|es|e|n|s)$/, '')
  return s.length >= 4 ? s : w
}

/**
 * Deutsche Komposita: Besteht das Wort fast vollständig aus mindestens zwei Begriffen des
 * Kandidaten (Fugenlaute wie das „s“ in „Bauantrag-s-unterlagen“ werden übersprungen)?
 */
function compoundScore(word: string, parts: string[]): number {
  const usable = parts.filter((p) => p.length >= 3 && p !== word).sort((a, b) => b.length - a.length)
  let pos = 0
  let covered = 0
  let used = 0
  while (pos < word.length) {
    const hit = usable.find((p) => word.startsWith(p, pos))
    if (hit) {
      covered += hit.length
      pos += hit.length
      used++
    } else pos++
  }
  return used >= 2 && covered / word.length >= 0.8 ? 0.88 : 0
}

export interface Candidate<T> {
  item: T
  /** Hauptbezeichnung */
  text: string
  /** Weitere Merkmale (Nummer, Ort, E-Mail, Phase …) - zählen etwas schwächer */
  extra?: string[]
  /** Bonus, z. B. für das aktuell geöffnete Projekt */
  boost?: number
}

export function rank<T>(query: string, candidates: Candidate<T>[], limit = 5, minScore = 0.5): { item: T; score: number }[] {
  return candidates
    .map((c) => {
      const base = Math.max(similarity(query, c.text), ...(c.extra ?? []).map((e) => similarity(query, e) * 0.9))
      return { item: c.item, score: base > 0 ? Math.min(1, base + (c.boost ?? 0)) : 0 }
    })
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export type Resolution<T> = { status: 'ok'; item: T } | { status: 'ambiguous'; options: T[] } | { status: 'not_found'; suggestions: T[] }

/** Genau ein Treffer, wenn eindeutig; sonst bis zu drei Optionen zur Rückfrage. */
export function resolveOne<T>(query: string, candidates: Candidate<T>[], byId?: (id: string) => T | undefined): Resolution<T> {
  const direct = byId?.(query.trim())
  if (direct) return { status: 'ok', item: direct }
  const ranked = rank(query, candidates, 4)
  // Nichts Sicheres gefunden: die ähnlichsten Namen trotzdem nennen („Meinst du …?“)
  if (!ranked.length) return { status: 'not_found', suggestions: rank(query, candidates, 3, 0.3).map((r) => r.item) }
  const [first, second] = ranked
  // Exakter Name schlägt ähnliche Namen („Bauantrag“ vor „Bauantrag einreichen“)
  if (first!.score >= 0.999 && (!second || second.score < 0.999)) return { status: 'ok', item: first!.item }
  if (first!.score >= 0.72 && (!second || first!.score - second.score >= 0.08 - 1e-9)) return { status: 'ok', item: first!.item }
  // Nur ein plausibler Kandidat überhaupt: das ist gemeint
  if (!second && first!.score >= 0.6) return { status: 'ok', item: first!.item }
  return { status: 'ambiguous', options: ranked.slice(0, 3).map((r) => r.item) }
}
