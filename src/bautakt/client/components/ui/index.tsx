/**
 * UI-Bausteine. Bewusst schlicht - die Tiefe liegt im Gantt und in der Engine.
 */

import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, ChevronRight } from 'lucide-react'
import type { HealthStatus, TaskStatus } from '../../../shared/types'
import { HEALTH_LABELS, TASK_STATUS_LABELS } from '../../../shared/labels'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type ButtonSize = 'sm' | 'md' | 'lg'

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean }) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition select-none',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'h-8 px-2.5 text-xs',
        size === 'md' && 'h-9 px-3.5 text-sm',
        size === 'lg' && 'h-11 px-5 text-base',
        variant === 'primary' && 'bg-brand text-white shadow-sm hover:bg-brand-strong',
        variant === 'secondary' && 'border border-line bg-surface text-ink shadow-sm hover:bg-surface-2',
        variant === 'outline' && 'border border-line-strong bg-transparent text-ink hover:bg-surface-2',
        variant === 'ghost' && 'text-ink-soft hover:bg-surface-3 hover:text-ink',
        variant === 'danger' && 'bg-danger text-white hover:bg-red-700',
        className,
      )}
      disabled={props.disabled || loading}
      {...props}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  )
}

export function IconButton({ className, title, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={clsx('inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-soft transition hover:bg-surface-3 hover:text-ink disabled:opacity-40', className)}
      {...props}
    />
  )
}

const CONTROL =
  'w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink shadow-sm outline-none transition placeholder:text-ink-faint focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:bg-surface-2 disabled:text-ink-faint'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(CONTROL, 'h-9', className)} {...props} />
}
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(CONTROL, 'resize-y py-2 leading-relaxed', className)} {...props} />
}
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(CONTROL, 'h-9 cursor-pointer pr-8', className)} {...props}>
      {children}
    </select>
  )
}
export function Checkbox({ label, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={clsx('inline-flex cursor-pointer items-center gap-2 text-sm', className)}>
      <input type="checkbox" className="h-4 w-4 rounded border-line-strong accent-brand" {...props} />
      {label}
    </label>
  )
}

export function Field({ label, hint, children, className, required }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; required?: boolean }) {
  return (
    <label className={clsx('block', className)}>
      <span className="mb-1 block text-xs font-medium text-ink-soft">
        {label}
        {required && <span className="text-danger"> *</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
    </label>
  )
}

export function Card({ className, children, title, actions, padded = true }: { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={clsx('rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)]', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(padded && 'p-4')}>{children}</div>
    </section>
  )
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumb?: { label: string; href?: string }[] }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {breadcrumb && (
          <nav className="mb-1 flex items-center gap-1 text-xs text-ink-faint">
            {breadcrumb.map((b, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={12} />}
                {b.href ? (
                  <a href={b.href} className="hover:text-ink">
                    {b.label}
                  </a>
                ) : (
                  <span>{b.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="truncate text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

type BadgeTone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'muted'
export function Badge({ tone = 'neutral', children, className, dot }: { tone?: BadgeTone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-surface-3 text-ink-soft',
        tone === 'brand' && 'bg-brand-soft text-brand',
        tone === 'ok' && 'bg-ok-soft text-ok',
        tone === 'warn' && 'bg-warn-soft text-warn',
        tone === 'danger' && 'bg-danger-soft text-danger',
        tone === 'muted' && 'bg-muted-soft text-muted',
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

export const HEALTH_TONE: Record<HealthStatus, BadgeTone> = { green: 'ok', yellow: 'warn', red: 'danger', grey: 'muted' }
export function HealthBadge({ health }: { health: HealthStatus }) {
  return (
    <Badge tone={HEALTH_TONE[health]} dot>
      {HEALTH_LABELS[health]}
    </Badge>
  )
}
export function HealthDot({ health, className }: { health: HealthStatus; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
        health === 'green' && 'bg-ok',
        health === 'yellow' && 'bg-warn',
        health === 'red' && 'bg-danger',
        health === 'grey' && 'bg-muted',
        className,
      )}
    />
  )
}

const STATUS_TONE: Record<TaskStatus, BadgeTone> = { not_started: 'neutral', in_progress: 'brand', at_risk: 'warn', done: 'ok', blocked: 'warn', delayed: 'danger' }
export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{TASK_STATUS_LABELS[status]}</Badge>
}

export function ProgressBar({ value, planned, className, tone }: { value: number; planned?: number; className?: string; tone?: 'brand' | 'ok' | 'danger' }) {
  return (
    <div className={clsx('relative h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)} title={`${value} %${planned !== undefined ? ` (Soll ${planned} %)` : ''}`}>
      <div className={clsx('h-full rounded-full', tone === 'ok' ? 'bg-ok' : tone === 'danger' ? 'bg-danger' : 'bg-brand')} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      {planned !== undefined && <div className="absolute top-0 h-full w-0.5 bg-ink/50" style={{ left: `${Math.max(0, Math.min(100, planned))}%` }} />}
    </div>
  )
}

export function KpiTile({ label, value, hint, tone, onClick, icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'brand' | 'neutral'; onClick?: () => void; icon?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx('flex flex-col items-start rounded-xl border border-line bg-surface p-4 text-left shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition', onClick && 'hover:border-line-strong hover:shadow-sm')}
    >
      <div className="flex w-full items-center justify-between text-xs font-medium text-ink-soft">
        <span>{label}</span>
        {icon && <span className="text-ink-faint">{icon}</span>}
      </div>
      <div
        className={clsx(
          'mt-1.5 text-2xl font-semibold tracking-tight',
          tone === 'ok' && 'text-ok',
          tone === 'warn' && 'text-warn',
          tone === 'danger' && 'text-danger',
          tone === 'brand' && 'text-brand',
          (!tone || tone === 'neutral') && 'text-ink',
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-ink-faint">{hint}</div>}
    </button>
  )
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong px-6 py-12 text-center">
      {icon && <div className="mb-3 text-ink-faint">{icon}</div>}
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-ink-soft">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Spinner({ label = 'Wird geladen …' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink-faint">
      <Loader2 size={18} className="animate-spin" /> {label}
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
      <span>{message}</span>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Erneut versuchen
        </Button>
      )}
    </div>
  )
}

export function Modal({ open, onClose, title, children, footer, width = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={clsx(
          'animate-fade-in flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-surface shadow-2xl sm:rounded-2xl',
          width === 'sm' && 'sm:max-w-md',
          width === 'md' && 'sm:max-w-xl',
          width === 'lg' && 'sm:max-w-3xl',
          width === 'xl' && 'sm:max-w-5xl',
        )}
        role="dialog"
        aria-modal
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <IconButton title="Schließen" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

export interface MenuItem {
  label: string
  icon?: ReactNode
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  shortcut?: string
}

/** Kontextmenü an einer Bildschirmposition (Rechtsklick) oder unter einem Element */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) })
  }, [x, y])
  useEffect(() => {
    const close = () => onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
      window.removeEventListener('scroll', close, true)
    }
  }, [onClose])
  return createPortal(
    <div ref={ref} className="animate-fade-in fixed z-[95] min-w-52 rounded-lg border border-line bg-surface p-1 shadow-xl" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="my-1 border-t border-line" />
        ) : (
          <button
            key={i}
            type="button"
            disabled={it.disabled}
            onClick={() => {
              it.onClick?.()
              onClose()
            }}
            className={clsx(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm disabled:opacity-40',
              it.danger ? 'text-danger hover:bg-danger-soft' : 'text-ink hover:bg-surface-3',
            )}
          >
            {it.icon && <span className="text-ink-faint">{it.icon}</span>}
            <span className="flex-1">{it.label}</span>
            {it.shortcut && <span className="text-[11px] text-ink-faint">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}

export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={clsx('inline-flex flex-wrap rounded-lg border border-line bg-surface-2 p-0.5', className)}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          onClick={() => onChange(it.value)}
          className={clsx('rounded-md px-3 py-1 text-xs font-medium transition', value === it.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-soft hover:text-ink')}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[10px] text-ink-soft">{children}</kbd>
}

export function Delta({ days, suffix = ' AT' }: { days: number; suffix?: string }) {
  if (days === 0) return <span className="text-ok">±0{suffix}</span>
  return <span className={days > 0 ? 'font-medium text-danger' : 'font-medium text-ok'}>{days > 0 ? '+' : ''}{days}{suffix}</span>
}

export function TradeChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      {name}
    </span>
  )
}
