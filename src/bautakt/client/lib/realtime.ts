import { useEffect, useRef } from 'react'
import { supabase } from '@/integrations/supabase/client'

export interface RealtimeEvent {
  kind: string
  org_id: string
  project_id?: string
  at: string
  [key: string]: unknown
}

/** Abonniert einen Broadcast-Kanal (z. B. `project:<id>` oder `org:<id>`) solange `channelName` gesetzt ist. */
export function useRealtimeChannel(channelName: string | null | undefined, onEvent: (event: RealtimeEvent) => void): void {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!channelName) return
    const channel = supabase
      .channel(channelName)
      .on('broadcast', { event: 'change' }, ({ payload }) => onEventRef.current(payload as RealtimeEvent))
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [channelName])
}
