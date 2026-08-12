import { useEffect, useState } from 'react'
import { IconCheck } from './Icons'
import type { HardwareSnapshot, DriverInventory } from '../../shared/types'

/**
 * Opening sequence.
 *
 * The ticks track real work: each line completes when the corresponding data has
 * actually arrived from the main process. If detection is slow, the sequence
 * waits; if it fails, the line says so instead of ticking anyway.
 */

interface Step {
  id: string
  label: string
  done: boolean
  failed: boolean
  detail: string | null
}

export function Boot({
  hardware,
  hardwareError,
  inventory,
  gameCount,
  onDone
}: {
  hardware: HardwareSnapshot | null
  hardwareError: string | null
  inventory: DriverInventory | null
  gameCount: number | null
  onDone: () => void
}) {
  const [leaving, setLeaving] = useState(false)
  const [minimumElapsed, setMinimumElapsed] = useState(false)

  const steps: Step[] = [
    {
      id: 'gpu',
      label: 'GPU',
      done: hardware !== null && hardware.gpus.length > 0,
      failed: hardwareError !== null || (hardware !== null && hardware.gpus.length === 0),
      detail: hardware?.gpus[0]?.name ?? null
    },
    {
      id: 'cpu',
      label: 'CPU',
      done: hardware !== null,
      failed: hardwareError !== null,
      detail: hardware?.cpu.name ?? null
    },
    {
      id: 'memory',
      label: 'MEMORY',
      done: hardware !== null,
      failed: hardwareError !== null,
      detail: hardware ? `${(hardware.memory.totalBytes / 1024 ** 3).toFixed(0)} GB` : null
    },
    {
      id: 'storage',
      label: 'STORAGE',
      done: hardware !== null,
      failed: hardwareError !== null,
      detail: hardware ? `${hardware.storage.length} drive(s)` : null
    },
    {
      id: 'drivers',
      label: 'DRIVERS',
      done: inventory !== null,
      failed: false,
      detail: inventory ? `${inventory.entries.length} packages` : null
    },
    {
      id: 'games',
      label: 'GAMES',
      done: gameCount !== null,
      failed: false,
      detail: gameCount === null ? null : `${gameCount} installed`
    }
  ]

  const ready = steps.every((step) => step.done || step.failed) && minimumElapsed
  const activeIndex = steps.findIndex((step) => !step.done && !step.failed)

  // A short floor keeps the sequence from flickering past on a warm cache.
  useEffect(() => {
    const id = setTimeout(() => setMinimumElapsed(true), 1500)
    return () => clearTimeout(id)
  }, [])

  useEffect(() => {
    if (!ready) return
    const hold = setTimeout(() => setLeaving(true), 850)
    const finish = setTimeout(onDone, 1400)
    return () => {
      clearTimeout(hold)
      clearTimeout(finish)
    }
  }, [ready, onDone])

  return (
    <div className={`boot${leaving ? ' boot--out' : ''}`}>
      <div className="boot__inner">
        <div className="boot__mark" />
        <div>
          <div className="boot__title">GameDriver Pro</div>
          <div className="boot__tag" style={{ marginTop: 10, textAlign: 'center' }}>
            Your PC. Your Games. Always Ready.
          </div>
        </div>

        <div className="boot__steps">
          {steps.map((step, index) => (
            <div
              key={step.id}
              className={`boot__step${step.done || step.failed ? ' is-done' : index === activeIndex ? ' is-active' : ''}`}
            >
              <span className="boot__tick" style={step.failed ? { color: 'var(--amber)' } : undefined}>
                {step.done ? <IconCheck size={13} /> : step.failed ? '!' : index === activeIndex ? '›' : ''}
              </span>
              <span style={{ width: 78 }}>{step.label}</span>
              <span className="boot__step-bar">
                <i style={{ width: step.done || step.failed ? '100%' : index === activeIndex ? '55%' : '0%' }} />
              </span>
              <span
                style={{
                  width: 190,
                  textAlign: 'right',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  opacity: 0.75
                }}
              >
                {step.failed && !step.done ? 'unavailable' : (step.detail ?? '')}
              </span>
            </div>
          ))}
        </div>

        <div style={{ minHeight: 26, display: 'grid', placeItems: 'center' }}>
          {ready ? (
            <div className="boot__ready">PC Ready</div>
          ) : (
            <div className="scanline" style={{ width: 190 }} />
          )}
        </div>
      </div>
    </div>
  )
}
