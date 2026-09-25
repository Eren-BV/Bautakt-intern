import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '../../shared/types'
import { can, type Capability } from '../../shared/permissions'
import { api, getToken, setToken } from '../lib/api'
import { supabase } from '@/integrations/supabase/client'
import { lovable } from '@/integrations/lovable'

export type SocialProvider = 'google' | 'microsoft' | 'apple'

interface AuthState {
  session: Session | null
  loading: boolean
  login(email: string, password: string): Promise<void>
  loginWithProvider(provider: SocialProvider): Promise<void>
  register(input: { email: string; name: string; password: string; orgName: string }): Promise<void>
  logout(): Promise<void>
  can(cap: Capability): boolean
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(!!getToken())

  useEffect(() => {
    if (!getToken()) return
    api.auth
      .me()
      .then(setSession)
      .catch(() => setToken(null))
      .finally(() => setLoading(false))
  }, [])

  // Rückkehr von Google / Microsoft / Apple: geprüftes Konto mit dem Zugang verbinden.
  useEffect(() => {
    if (getToken()) return
    let cancelled = false
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      const accessToken = data.session?.access_token
      if (!accessToken || cancelled) return
      setLoading(true)
      try {
        const s = await api.auth.oauth(accessToken)
        if (cancelled) return
        setToken(s.token)
        setSession(s)
      } catch {
        await supabase.auth.signOut().catch(() => {})
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])


  const login = useCallback(async (email: string, password: string) => {
    const s = await api.auth.login(email, password)
    setToken(s.token)
    setSession(s)
  }, [])
  const loginWithProvider = useCallback(async (provider: SocialProvider) => {
    const result = await lovable.auth.signInWithOAuth(provider, { redirect_uri: window.location.origin })
    if (result.error) throw new Error('Anmeldung wurde abgebrochen oder ist fehlgeschlagen.')
    if (result.redirected) return
    const { data } = await supabase.auth.getSession()
    const accessToken = data.session?.access_token
    if (!accessToken) throw new Error('Anmeldung konnte nicht bestätigt werden.')
    const s = await api.auth.oauth(accessToken)
    setToken(s.token)
    setSession(s)
  }, [])
  const register = useCallback(async (input: { email: string; name: string; password: string; orgName: string }) => {
    const s = await api.auth.register(input)
    setToken(s.token)
    setSession(s)
  }, [])
  const logout = useCallback(async () => {
    try {
      await api.auth.logout()
    } finally {
      setToken(null)
      setSession(null)
      await supabase.auth.signOut().catch(() => {})
    }
  }, [])

  const value = useMemo<AuthState>(
    () => ({ session, loading, login, loginWithProvider, register, logout, can: (cap) => can(session?.role, cap) }),
    [session, loading, login, loginWithProvider, register, logout],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth außerhalb von AuthProvider')
  return ctx
}
