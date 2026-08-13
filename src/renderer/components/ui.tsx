import { useEffect, useState, type ReactNode } from 'react'
import { IconAlert, IconCheck, IconInfo, IconX } from './Icons'
import { DASH } from '../lib/format'

/** Shared presentational primitives. */

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'brand' | 'muted'

export function Panel({
  title,
  note,
  actions,
  children,
  flush,
  accent,
  icon
}: {
  title?: ReactNode
  note?: ReactNode
  actions?: ReactNode
  children: ReactNode
  flush?: boolean
  accent?: boolean
  icon?: ReactNode
}) {
  return (
    <section className={`panel${flush ? ' panel--flush' : ''}${accent ? ' panel--accent' : ''}`}>
      {(title || actions) && (
        <header className="panel__head" style={flush ? { padding: '18px 20px 0' } : undefined}>
          <div>
            <div className="panel__title">
              {icon}
              {title}
            </div>
            {note && <div className="panel__note" style={{ marginTop: 4 }}>{note}</div>}
          </div>
          {actions && <div className="split">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

export function StatusDot({ tone = 'ok', pulse }: { tone?: Tone; pulse?: boolean }) {
  const colors: Record<Tone, string> = {
    ok: 'var(--lime)',
    warn: 'var(--amber)',
    bad: 'var(--rose)',
    info: 'var(--cyan)',
    brand: 'var(--violet)',
    muted: 'var(--text-faint)'
  }
  return <i className={`dot${pulse ? ' dot--pulse' : ''}`} style={{ color: colors[tone] }} />
}

export function Stat({
  label,
  value,
  unit,
  meta,
  tone,
  live,
  children
}: {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  meta?: ReactNode
  tone?: Tone
  live?: boolean
  children?: ReactNode
}) {
  const colors: Record<Tone, string> = {
    ok: 'var(--lime)',
    warn: 'var(--amber)',
    bad: 'var(--rose)',
    info: 'var(--cyan)',
    brand: '#c4b5fd',
    muted: 'var(--text)'
  }
  return (
    <div className={`stat${live ? ' stat--live' : ''}`}>
      <div className="stat__label">{label}</div>
      <div className="stat__value" style={tone ? { color: colors[tone] } : undefined}>
        <span className="stat__value-text">{value}</span>
        {unit && <span className="stat__unit">{unit}</span>}
      </div>
      {meta !== undefined && <div className="stat__meta">{meta}</div>}
      {children}
    </div>
  )
}

export function Button({
  variant = 'default',
  size,
  block,
  loading,
  icon,
  children,
  ...rest
}: {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'lg'
  block?: boolean
  loading?: boolean
  icon?: ReactNode
  children?: ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = [
    'btn',
    variant !== 'default' ? `btn--${variant}` : '',
    size === 'lg' ? 'btn--lg' : '',
    block ? 'btn--block' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button className={classes} disabled={rest.disabled || loading} {...rest}>
      {loading ? <i className="btn__spin" /> : icon}
      {children}
    </button>
  )
}

export function Bar({
  value,
  tone,
  indeterminate
}: {
  value: number | null
  tone?: 'ok' | 'warn' | 'bad'
  indeterminate?: boolean
}) {
  // A null percentage means the underlying operation genuinely reports none, so
  // the bar animates as indeterminate instead of showing an invented number.
  const isIndeterminate = indeterminate || value === null
  return (
    <div className={`bar${isIndeterminate ? ' bar--indeterminate' : ''}`}>
      <div
        className={`bar__fill${tone ? ` bar__fill--${tone}` : ''}`}
        style={{ width: isIndeterminate ? undefined : `${Math.max(0, Math.min(100, value ?? 0))}%` }}
      />
    </div>
  )
}

export function SegBar({ value, segments = 20 }: { value: number; segments?: number }) {
  const on = Math.round((Math.max(0, Math.min(100, value)) / 100) * segments)
  return (
    <div className="segbar">
      {Array.from({ length: segments }, (_, index) => (
        <span key={index} className={index < on ? 'on' : ''} />
      ))}
    </div>
  )
}

export function Ring({
  value,
  size = 132,
  stroke = 10,
  label,
  caption
}: {
  value: number
  size?: number
  stroke?: number
  label?: ReactNode
  caption?: string
}) {
  // The arc's glow needs clear space inside the SVG viewport. Drawn edge to
  // edge, the drop-shadow is clipped by the viewport and the blur stops in a
  // hard square instead of fading out. Insetting the circle by more than the
  // blur radius lets the glow fall off naturally, and keeps the SVG box exactly
  // `size` so nothing overflows or shifts the surrounding layout.
  const glow = Math.max(4, Math.round(stroke * 0.7))
  const inset = glow * 2
  const radius = Math.max(1, (size - stroke) / 2 - inset)
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, value))
  const [drawn, setDrawn] = useState(0)

  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(clamped))
    return () => cancelAnimationFrame(id)
  }, [clamped])

  const color = clamped >= 85 ? 'var(--lime)' : clamped >= 65 ? 'var(--amber)' : 'var(--rose)'

  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={radius} stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - (drawn / 100) * circumference}
          style={{
            transition: 'stroke-dashoffset 1.1s cubic-bezier(0.22,1,0.36,1)',
            filter: `drop-shadow(0 0 ${glow}px ${color})`
          }}
        />
      </svg>
      <div className="ring__value">
        <span className="ring__num" style={{ color }}>
          {label ?? Math.round(clamped)}
        </span>
        {caption && <span className="ring__cap">{caption}</span>}
      </div>
    </div>
  )
}

export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad' | 'plain'; children: ReactNode }) {
  const Icon = tone === 'bad' || tone === 'warn' ? IconAlert : IconInfo
  return (
    <div className={`note${tone === 'plain' ? '' : ` note--${tone}`}`}>
      <span className="note__icon">
        <Icon size={15} />
      </span>
      <div>{children}</div>
    </div>
  )
}

export function Empty({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty__icon">{icon}</div>}
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      {body && <div className="small" style={{ maxWidth: '52ch' }}>{body}</div>}
      {action}
    </div>
  )
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number | string; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} />
}

export function KeyValues({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([key, value], index) => (
        <div key={index} style={{ display: 'contents' }}>
          <dt>{key}</dt>
          <dd>{value ?? DASH}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track" />
      <span>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 550 }}>{label}</span>
        {description && (
          <span className="small faint" style={{ display: 'block', marginTop: 2, lineHeight: 1.5 }}>
            {description}
          </span>
        )}
      </span>
    </label>
  )
}

export function Modal({
  title,
  subtitle,
  children,
  actions,
  onClose
}: {
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  actions?: ReactNode
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="split" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div className="modal__title">{title}</div>
            {subtitle && <div className="small muted">{subtitle}</div>}
          </div>
          <button className="btn btn--ghost" style={{ padding: 7 }} onClick={onClose} aria-label="Close">
            <IconX size={15} />
          </button>
        </div>
        <div style={{ marginTop: 18 }}>{children}</div>
        {actions && <div className="modal__actions">{actions}</div>}
      </div>
    </div>
  )
}

export function Tabs<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { id: T; label: ReactNode }[]
  onChange: (next: T) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {options.map((option) => (
        <button
          key={option.id}
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function CheckRow({
  checked,
  onChange,
  title,
  body,
  disabled,
  right
}: {
  checked: boolean
  onChange: (next: boolean) => void
  title: ReactNode
  body?: ReactNode
  disabled?: boolean
  right?: ReactNode
}) {
  return (
    <label className={`check${disabled ? ' check--disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 550 }}>{title}</span>
        {body && (
          <span className="small faint" style={{ display: 'block', marginTop: 3, lineHeight: 1.5 }}>
            {body}
          </span>
        )}
      </span>
      {right}
    </label>
  )
}

export function StateIcon({ state }: { state: 'pass' | 'warn' | 'fail' | 'unknown' }) {
  if (state === 'pass') return <span style={{ color: 'var(--lime)' }}><IconCheck size={15} /></span>
  if (state === 'warn') return <span style={{ color: 'var(--amber)' }}><IconAlert size={15} /></span>
  if (state === 'fail') return <span style={{ color: 'var(--rose)' }}><IconX size={15} /></span>
  return <span style={{ color: 'var(--text-faint)' }}><IconInfo size={15} /></span>
}
