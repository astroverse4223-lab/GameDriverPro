import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { StoreProvider, useStore } from './lib/store'
import { api } from './lib/api'
import { Boot } from './components/Boot'
import { Nav, TitleBar, Toasts } from './components/Shell'
import { Note } from './components/ui'
import { HomePage } from './pages/Home'
import { MyPcPage } from './pages/MyPc'
import { DriversPage } from './pages/Drivers'
import { GamesPage } from './pages/Games'
import { BoostPage } from './pages/Boost'
import { PerformancePage } from './pages/Performance'
import { CrashesPage } from './pages/Crashes'
import { NetworkPage } from './pages/Network'
import { HistoryPage } from './pages/History'
import { SettingsPage } from './pages/Settings'
import { DeveloperPage } from './pages/Developer'

/** A render error in one screen must not take the whole command centre down. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Renderer error', error, info)
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="page">
          <div className="page__head">
            <div>
              <div className="eyebrow">Something broke</div>
              <h1 className="page__title">This screen could not be drawn</h1>
            </div>
          </div>
          <Note tone="bad">
            <strong>{this.state.error.message}</strong>
            <div style={{ marginTop: 8 }}>
              The rest of the app is still running — switch to another screen, or reload the window.
            </div>
            <button className="btn" style={{ marginTop: 12 }} onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </Note>
        </div>
      )
    }
    return this.props.children
  }
}

function Routes() {
  const { route } = useStore()
  switch (route) {
    case 'home':
      return <HomePage />
    case 'mypc':
      return <MyPcPage />
    case 'drivers':
      return <DriversPage />
    case 'games':
      return <GamesPage />
    case 'boost':
      return <BoostPage />
    case 'performance':
      return <PerformancePage />
    case 'crashes':
      return <CrashesPage />
    case 'network':
      return <NetworkPage />
    case 'history':
      return <HistoryPage />
    case 'settings':
      return <SettingsPage />
    case 'developer':
      return <DeveloperPage />
    default:
      return <HomePage />
  }
}

function Shell() {
  const { hardware, hardwareError, inventory } = useStore()
  const [booted, setBooted] = useState(false)
  const [gameCount, setGameCount] = useState<number | null>(null)

  // Game detection runs alongside the boot sequence so the last tick reflects a
  // real result rather than a timer.
  useEffect(() => {
    let cancelled = false
    api.games
      .list(false)
      .then((library) => {
        if (!cancelled) setGameCount(library.games.length)
      })
      .catch(() => {
        if (!cancelled) setGameCount(0)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      {!booted && (
        <Boot
          hardware={hardware}
          hardwareError={hardwareError}
          inventory={inventory}
          gameCount={gameCount}
          onDone={() => setBooted(true)}
        />
      )}
      <div className="app">
        <TitleBar />
        <div className="body">
          <Nav />
          <main className="main">
            <ErrorBoundary>
              <Routes />
            </ErrorBoundary>
          </main>
        </div>
      </div>
      <Toasts />
    </>
  )
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
