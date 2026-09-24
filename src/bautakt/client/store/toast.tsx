import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'

type ToastKind = 'info' | 'success' | 'error'
interface Toast {
  id: number
  kind: ToastKind
  message: string
}

const ToastContext = createContext<{ push(message: string, kind?: ToastKind): void } | null>(null)
let seq = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = seq++
    setToasts((t) => [...t, { id, kind, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500)
  }, [])
  const value = useMemo(() => ({ push }), [push])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'animate-fade-in pointer-events-auto rounded-lg px-4 py-2.5 text-sm shadow-lg',
              t.kind === 'error' && 'bg-danger text-white',
              t.kind === 'success' && 'bg-ok text-white',
              t.kind === 'info' && 'bg-ink text-white',
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast außerhalb von ToastProvider')
  return ctx
}
