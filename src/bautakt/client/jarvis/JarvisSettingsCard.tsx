/**
 * Einstellungen für Jarvis - je Nutzer im Browser gespeichert (Vorlesen, Stimme,
 * Ansicht folgt Jarvis, „Hi Jarvis“ nur auf ausdrücklichen Wunsch).
 */

import type { ReactNode } from 'react'
import { Sparkles, Volume2 } from 'lucide-react'
import { Badge, Button, Card, Kbd, Select } from '../components/ui'
import { jarvis, useJarvis } from './engine'

export function JarvisSettingsCard() {
  const state = useJarvis()
  const s = state.settings
  const wakeSupported = jarvis.wakeSupported()
  const server = state.server
  const mic =
    state.mic === 'native'
      ? 'über den Browser (Chrome/Edge übertragen das Audio dafür an Google bzw. Microsoft)'
      : state.mic === 'recorder'
        ? 'über den KI-Dienst (Aufnahme wird nur zur Erkennung übertragen)'
        : 'in diesem Browser nicht verfügbar – Jarvis funktioniert per Texteingabe'

  return (
    <div id="jarvis" className="scroll-mt-20">
      <Card
        title={
          <span className="flex items-center gap-2">
            <Sparkles size={15} /> Jarvis – Sprachassistent
            {server && (server.ai ? <Badge tone="ok">aktiv</Badge> : <Badge tone="warn">KI nicht eingerichtet</Badge>)}
          </span>
        }
      >
        <p className="mb-4 text-sm text-ink-soft">
          Jarvis erledigt Aufgaben per Sprache oder Text: Termine verschieben, Aufgaben verteilen, Fortschritt melden, Projekte anlegen. Größere Änderungen werden vorher
          bestätigt, jede Änderung lässt sich rückgängig machen und steht in der Historie als „KI (Jarvis)“. Starten: Knopf unten links oder <Kbd>Alt</Kbd> + <Kbd>J</Kbd>.
        </p>
        <div className="space-y-4">
          <Toggle
            label="Antworten vorlesen"
            hint="Wer Jarvis per Sprache fragt, bekommt die Antwort auch gesprochen."
            checked={s.speak}
            onChange={(v) => jarvis.setSettings({ speak: v })}
          />
          <div className="flex flex-wrap items-end gap-2 pl-6">
            <label className="block min-w-56 flex-1">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Stimme</span>
              <Select value={s.voice} disabled={!s.speak} onChange={(e) => jarvis.setSettings({ voice: e.target.value as 'cloud' | 'browser' })}>
                <option value="cloud">Natürliche KI-Stimme (empfohlen)</option>
                <option value="browser">Stimme des Geräts (ohne Übertragung)</option>
              </Select>
            </label>
            <Button onClick={() => jarvis.testVoice()} disabled={!s.speak}>
              <Volume2 size={15} /> Stimme testen
            </Button>
          </div>
          {s.voice === 'cloud' && server && !server.tts && s.speak && (
            <p className="pl-6 text-xs text-warn">Die KI-Stimme ist gerade nicht verfügbar – Jarvis nutzt die Stimme des Geräts.</p>
          )}
          <Toggle
            label="Einfach reinreden unterbricht Jarvis"
            hint="Während Jarvis spricht, hört das Mikrofon kurz mit – fängst du an zu reden, bricht Jarvis sofort ab und hört zu. Kein Antippen des Mikrofons nötig."
            checked={s.bargeIn}
            onChange={(v) => jarvis.setSettings({ bargeIn: v })}
          />
          <Toggle
            label="Ansicht folgt Jarvis"
            hint="Jarvis öffnet den passenden Terminplan und springt zum Vorgang, um den es gerade geht (am Computer)."
            checked={s.autoFollow}
            onChange={(v) => jarvis.setSettings({ autoFollow: v })}
          />
          <Toggle
            label={`„${jarvis.wakePhrase()}“ zum Aufwecken`}
            hint={
              !wakeSupported ? (
                'Nur am Computer verfügbar.'
              ) : jarvis.wakeIsLocal() ? (
                <>
                  Das Mikrofon hört mit, solange BauTakt geöffnet ist, und reagiert nur auf „Hey Jarvis“. Die Erkennung läuft direkt auf diesem Rechner – bis zum
                  Aufwecken verlässt kein Ton das Gerät. Nach 15 Minuten ohne Bedienung pausiert das Zuhören automatisch.
                </>
              ) : (
                <>
                  Das Mikrofon hört mit, solange BauTakt geöffnet ist, und reagiert nur auf „Hi Jarvis“. <b>Datenschutz:</b> Chrome und Edge übertragen das Audio dafür laufend an
                  Google bzw. Microsoft. Nach 15 Minuten ohne Bedienung pausiert das Zuhören automatisch.
                </>
              )
            }
            checked={s.wakeWord && wakeSupported}
            disabled={!wakeSupported}
            onChange={(v) => jarvis.setSettings({ wakeWord: v })}
          />
        </div>
        <p className="mt-4 text-xs text-ink-faint">Spracherkennung {mic}. Die Einstellungen gelten für dieses Gerät.</p>
      </Card>
    </div>
  )
}

function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint: ReactNode; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`flex items-start gap-2.5 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 rounded border-line-strong accent-brand" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium text-ink">{label}</span>
        <span className="mt-0.5 block text-xs text-ink-soft">{hint}</span>
      </span>
    </label>
  )
}
