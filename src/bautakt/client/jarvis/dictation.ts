/**
 * Diktierfunktion für einzelne Formularfelder (unabhängig vom Jarvis-Assistenten, nutzt aber
 * dieselbe Spracherkennung: eingebaute Browser-Erkennung, sonst Aufnahme + Server-Transkription).
 * Bewusst leichtgewichtig - kein Wake-Word, kein Dialog, nur "Mikro an, Text kommt an, Mikro aus".
 */

import { useEffect, useRef, useState } from 'react'
import { CommandListener, RecorderListener, germanRecognitionAvailable, hasNativeRecognition, hasRecorder, type Listener } from './speech'

export function dictationSupported(): boolean {
  return hasNativeRecognition() || hasRecorder()
}

const SILENCE_MS = 6000
const MAX_MS = 60_000

export function useDictation(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const listenerRef = useRef<Listener | null>(null)
  const forceRecorder = useRef(false)
  const onFinalRef = useRef(onFinal)
  onFinalRef.current = onFinal

  useEffect(() => {
    let live = true
    void germanRecognitionAvailable().then((s) => {
      if (live && s === 'unavailable') forceRecorder.current = true
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => () => listenerRef.current?.abort(), [])

  const stop = () => listenerRef.current?.stop()

  const start = () => {
    if (listenerRef.current) return
    const useNative = hasNativeRecognition() && !forceRecorder.current
    if (!useNative && !hasRecorder()) {
      setError('unsupported')
      return
    }
    const listener: Listener = useNative ? new CommandListener() : new RecorderListener()
    listenerRef.current = listener
    setError(null)
    setInterim('')
    setListening(true)
    listener.start(
      {
        onInterim: (text) => setInterim(text),
        onFinal: (text) => text.trim() && onFinalRef.current(text.trim()),
        onEnd: () => {
          listenerRef.current = null
          setListening(false)
          setInterim('')
        },
        onError: (code) => {
          if (code !== 'no-speech' && code !== 'aborted') setError(code)
          listenerRef.current = null
          setListening(false)
          setInterim('')
        },
      },
      { silenceMs: SILENCE_MS, maxMs: MAX_MS },
    )
  }

  const toggle = () => (listening ? stop() : start())

  return { listening, interim, error, toggle, start, supported: dictationSupported() }
}
