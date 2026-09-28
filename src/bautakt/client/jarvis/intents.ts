/**
 * Einfache Absichten, die ohne KI erkannt werden: Zustimmung/Ablehnung bei offener
 * Bestätigung, Stopp, Dank/Verabschiedung. Spart Zeit und Kosten.
 */

const norm = (s: string) =>
  s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim()

const YES = /^(ja|jawohl|jo|jup|klar|genau|okay|ok|passt|gut|super|prima|richtig|einverstanden|bestaetige|bestaetigt|mach|machs|mach das|mach es|los|gerne|bitte)( (ja|mach|das|es|so|bitte|boss|jarvis|chef|los|gerne|genau))*$/
const NO = /^(nein|nee|ne|abbrechen|lass|lass es|lass das|stopp|stop|doch nicht|lieber nicht|nicht)( (nein|lass|es|das|mal|lieber|nicht|bitte|boss|jarvis|danke))*$/
const STOP = /^(jarvis )?(stopp|stop|halt|ruhe|sei still|abbrechen|schluss)( (jarvis|bitte))?$/
const THANKS = /^(danke|vielen dank|danke schoen|dankeschoen|tschuess|bis spaeter|ciao|das wars|das war es|passt danke)( (jarvis|boss|dir|schoen|sehr))*$/

export type Answer = 'yes' | 'no' | null

export function confirmationAnswer(text: string): Answer {
  const t = norm(text)
  if (!t || t.split(' ').length > 6) return null
  if (NO.test(t)) return 'no'
  if (YES.test(t)) return 'yes'
  return null
}

export function isStop(text: string): boolean {
  return STOP.test(norm(text))
}

export function isThanks(text: string): boolean {
  return THANKS.test(norm(text))
}

/** „Hi Jarvis“, „Hey Jarvis“, „Hallo Jarvis“ … - liefert den Rest des Satzes (evtl. leer) oder null. */
export function wakeMatch(text: string): string | null {
  const t = norm(text)
  const m = /(?:^| )(?:hi|hey|hallo|ok|okay|he)? ?(?:jarvis|jervis|dschawis|tschawis|javis)(?: |$)(.*)$/.exec(t)
  return m ? m[1]!.trim() : null
}
