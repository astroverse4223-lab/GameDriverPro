import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from './api'

/**
 * Async state with the three outcomes the UI actually needs to draw: loading,
 * data, and a human-readable error. A failed system query must render as a
 * message, never as an empty screen that looks like "nothing found".
 */
export interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: (...args: unknown[]) => void
  setData: (value: T) => void
}

export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = [], immediate = true): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(immediate)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(() => {
    setLoading(true)
    setError(null)
    loaderRef
      .current()
      .then((value) => {
        if (!mounted.current) return
        setData(value)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!mounted.current) return
        setError(errorMessage(cause))
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (immediate) run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, loading, error, reload: run, setData }
}

/** A fixed-length ring of samples for the live charts. */
export function useHistory<T>(capacity: number): [T[], (sample: T) => void, () => void] {
  const [samples, setSamples] = useState<T[]>([])
  const push = useCallback(
    (sample: T) => {
      setSamples((previous) => {
        const next = previous.length >= capacity ? previous.slice(previous.length - capacity + 1) : previous.slice()
        next.push(sample)
        return next
      })
    },
    [capacity]
  )
  const clear = useCallback(() => setSamples([]), [])
  return [samples, push, clear]
}

export function useInterval(callback: () => void, delayMs: number | null): void {
  const saved = useRef(callback)
  saved.current = callback
  useEffect(() => {
    if (delayMs === null) return
    const id = setInterval(() => saved.current(), delayMs)
    return () => clearInterval(id)
  }, [delayMs])
}

/** Smoothly animates a number so counters count up instead of snapping. */
export function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    const start = performance.now()
    const origin = from.current
    let frame = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      const eased = 1 - Math.pow(1 - t, 3)
      const next = origin + (target - origin) * eased
      setValue(next)
      if (t < 1) frame = requestAnimationFrame(step)
      else from.current = target
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target, durationMs])
  return value
}
