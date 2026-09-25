import { useState, type FormEvent } from 'react'
import { GanttChartSquare } from 'lucide-react'
import { Button, Field, Input } from '../components/ui'
import { useAuth } from '../store/auth'

const PROVIDERS = [
  { id: 'google' as const, label: 'Mit Google fortfahren' },
  { id: 'microsoft' as const, label: 'Mit Microsoft fortfahren' },
  { id: 'apple' as const, label: 'Mit Apple fortfahren' },
]

export function LoginPage() {
  const { login, register, loginWithProvider } = useAuth()
  const [socialBusy, setSocialBusy] = useState<string | null>(null)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [orgName, setOrgName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const social = async (provider: 'google' | 'microsoft' | 'apple') => {
    setSocialBusy(provider)
    setError(null)
    try {
      await loginWithProvider(provider)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSocialBusy(null)
    }
  }


  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode === 'login') await login(email, password)
      else await register({ email, password, name, orgName })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen">
      <div className="hidden w-[46%] flex-col justify-between bg-sidebar p-10 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand">
            <GanttChartSquare size={18} />
          </span>
          <span className="text-lg font-semibold tracking-tight">BauTakt</span>
        </div>
        <div>
          <h1 className="max-w-md text-3xl font-semibold leading-tight tracking-tight">Bauzeitenplanung, die auf der Baustelle ankommt.</h1>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-white/70">
            Gantt mit echter Terminlogik, kritischer Pfad, Soll-Ist-Vergleich und ein Baustellen-Update, das in zehn Sekunden erledigt ist. Für Bauunternehmen, Generalunternehmer und Sanierer.
          </p>
        </div>
        <div className="text-xs text-white/40">© {new Date().getFullYear()} BauTakt · BuildVision</div>
      </div>
      <div className="flex flex-1 items-center justify-center bg-shell p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-white">
              <GanttChartSquare size={16} />
            </span>
            <span className="font-semibold">BauTakt</span>
          </div>
          <h2 className="text-xl font-semibold tracking-tight">{mode === 'login' ? 'Anmelden' : 'Organisation anlegen'}</h2>
          <p className="mt-1 text-sm text-ink-soft">{mode === 'login' ? 'Willkommen zurück.' : 'Erstellen Sie Ihren eigenen Mandanten – Daten bleiben strikt getrennt.'}</p>
          <div className="mt-6 space-y-2">
            {PROVIDERS.map((p) => (
              <Button
                key={p.id}
                type="button"
                variant="secondary"
                size="lg"
                className="w-full"
                loading={socialBusy === p.id}
                disabled={!!socialBusy || busy}
                onClick={() => social(p.id)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <div className="my-5 flex items-center gap-3 text-xs text-ink-soft">
            <span className="h-px flex-1 bg-border" />
            oder mit E-Mail und Passwort
            <span className="h-px flex-1 bg-border" />
          </div>
          <form onSubmit={submit} className="space-y-4">
            {mode === 'register' && (
              <>
                <Field label="Firma / Organisation" required>
                  <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Baumission GmbH" required />
                </Field>
                <Field label="Ihr Name" required>
                  <Input value={name} onChange={(e) => setName(e.target.value)} required />
                </Field>
              </>
            )}
            <Field label="E-Mail" required>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
            </Field>
            <Field label="Passwort" required hint={mode === 'register' ? 'Mindestens 8 Zeichen' : undefined}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
            </Field>
            {error && <div className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
              {mode === 'login' ? 'Anmelden' : 'Organisation erstellen'}
            </Button>
          </form>
          <button type="button" className="mt-4 text-sm text-brand hover:underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Neue Organisation registrieren' : 'Zurück zur Anmeldung'}
          </button>
        </div>
      </div>
    </div>
  )
}
