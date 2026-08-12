import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { StatusDot } from './ui'
import {
  IconAlert,
  IconBolt,
  IconChip,
  IconGamepad,
  IconHistory,
  IconHome,
  IconMinus,
  IconPc,
  IconPulse,
  IconSettings,
  IconSquare,
  IconTerminal,
  IconWifi,
  IconX
} from './Icons'
import type { AppRoute } from '../../shared/types'
import type { JSX } from 'react'

const NAV: { group: string; items: { id: AppRoute; label: string; Icon: (p: { size?: number }) => JSX.Element }[] }[] = [
  {
    group: 'Overview',
    items: [
      { id: 'home', label: 'Home', Icon: IconHome },
      { id: 'mypc', label: 'My PC', Icon: IconPc }
    ]
  },
  {
    group: 'Drivers',
    items: [
      { id: 'drivers', label: 'Drivers', Icon: IconChip },
      { id: 'history', label: 'History', Icon: IconHistory }
    ]
  },
  {
    group: 'Gaming',
    items: [
      { id: 'games', label: 'Games', Icon: IconGamepad },
      { id: 'boost', label: 'Boost', Icon: IconBolt },
      { id: 'performance', label: 'Performance', Icon: IconPulse }
    ]
  },
  {
    group: 'Diagnostics',
    items: [
      { id: 'crashes', label: 'Crashes', Icon: IconAlert },
      { id: 'network', label: 'Network', Icon: IconWifi }
    ]
  }
]

export function TitleBar() {
  const { hardware, monitoring, latest } = useStore()

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <span className="titlebar__mark" />
        GameDriver Pro
      </div>
      <div className="titlebar__spacer" />
      <div className="titlebar__status">
        {hardware && (
          <>
            <StatusDot tone={hardware.system.isElevated ? 'ok' : 'muted'} />
            <span>{hardware.system.isElevated ? 'ADMIN' : 'STANDARD'}</span>
            <span style={{ opacity: 0.3 }}>|</span>
          </>
        )}
        {monitoring && latest ? (
          <>
            <StatusDot tone="info" pulse />
            <span>
              CPU {latest.cpu.usagePercent === null ? '—' : `${latest.cpu.usagePercent.toFixed(0)}%`}
              {latest.gpus[0]?.usagePercent !== null && latest.gpus[0]?.usagePercent !== undefined
                ? ` · GPU ${latest.gpus[0].usagePercent.toFixed(0)}%`
                : ''}
            </span>
          </>
        ) : (
          <span style={{ opacity: 0.7 }}>{hardware?.system.hostname ?? ''}</span>
        )}
      </div>
      <div className="wincontrols">
        <button onClick={() => void api.app.windowControl({ action: 'minimize' })} aria-label="Minimise">
          <IconMinus size={14} />
        </button>
        <button onClick={() => void api.app.windowControl({ action: 'maximize' })} aria-label="Maximise">
          <IconSquare size={12} />
        </button>
        <button className="close" onClick={() => void api.app.windowControl({ action: 'close' })} aria-label="Close">
          <IconX size={14} />
        </button>
      </div>
    </header>
  )
}

export function Nav() {
  const { route, navigate, scan, inventory, settings, hardware } = useStore()

  const actionable = scan?.updates.filter((u) => u.classification === 'critical' || u.classification === 'recommended').length ?? 0
  const problems = inventory?.problemDevices ?? 0

  const badgeFor = (id: AppRoute): { count: number; critical: boolean } | null => {
    if (id === 'drivers' && (actionable > 0 || problems > 0)) {
      return { count: actionable + problems, critical: problems > 0 }
    }
    return null
  }

  const groups = settings?.developerMode
    ? [...NAV, { group: 'Advanced', items: [{ id: 'developer' as AppRoute, label: 'Developer', Icon: IconTerminal }] }]
    : NAV

  return (
    <nav className="nav">
      {groups.map((group) => (
        <div key={group.group}>
          <div className="nav__group">{group.group}</div>
          {group.items.map(({ id, label, Icon }) => {
            const badge = badgeFor(id)
            return (
              <button
                key={id}
                className="nav__item"
                aria-current={route === id ? 'page' : undefined}
                onClick={() => navigate(id)}
                title={label}
              >
                <Icon size={17} />
                <span className="nav__label">{label}</span>
                {badge && <span className={`nav__badge${badge.critical ? ' is-critical' : ''}`}>{badge.count}</span>}
              </button>
            )
          })}
        </div>
      ))}

      <div style={{ marginTop: 14 }}>
        <button
          className="nav__item"
          aria-current={route === 'settings' ? 'page' : undefined}
          onClick={() => navigate('settings')}
          title="Settings"
        >
          <IconSettings size={17} />
          <span className="nav__label">Settings</span>
        </button>
      </div>

      <div className="nav__foot">
        <div>{hardware?.cpu.name.replace(/\(R\)|\(TM\)|CPU|@.*/g, '').trim() ?? '—'}</div>
        <div style={{ color: 'var(--accent)' }}>{hardware?.gpus[0]?.name ?? '—'}</div>
        <div>v{api.meta.appVersion}</div>
      </div>
    </nav>
  )
}

export function Toasts() {
  const { toasts, dismissToast } = useStore()
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} onClick={() => dismissToast(toast.id)}>
          <StatusDot tone={toast.tone === 'success' ? 'ok' : toast.tone === 'danger' ? 'bad' : toast.tone === 'warning' ? 'warn' : 'info'} />
          <div style={{ flex: 1 }}>
            <div className="toast__title">{toast.title}</div>
            {toast.body && <div className="toast__body">{toast.body}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
