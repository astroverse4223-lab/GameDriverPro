import { useEffect, useRef } from 'react'

export interface Series {
  label: string
  color: string
  values: (number | null)[]
  /** Fixed upper bound; when absent the chart scales to the data. */
  max?: number
  fill?: boolean
}

/**
 * Canvas line chart for live telemetry.
 *
 * Null samples break the line rather than being interpolated: if a sensor stops
 * reporting, the gap is visible instead of being smoothed into a plausible
 * curve. Redraws are confined to a single canvas so a 1 Hz telemetry stream
 * costs no React reconciliation.
 */
export function Chart({
  series,
  height = 150,
  capacity,
  yMax,
  unit = '%',
  grid = true
}: {
  series: Series[]
  height?: number
  capacity: number
  yMax?: number
  unit?: string
  grid?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const ratio = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    if (width === 0) return
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)

    const padTop = 8
    const padBottom = 16
    const padLeft = 34
    const plotWidth = width - padLeft - 6
    const plotHeight = height - padTop - padBottom

    // Scale: honour an explicit max, otherwise fit the data with headroom.
    let max = yMax ?? 0
    if (!yMax) {
      for (const line of series) {
        for (const value of line.values) {
          if (value !== null && Number.isFinite(value)) max = Math.max(max, value)
        }
      }
      max = max <= 0 ? 1 : max * 1.15
    }

    context.font = '10px ui-monospace, Consolas, monospace'
    context.textBaseline = 'middle'

    if (grid) {
      const lines = 4
      for (let index = 0; index <= lines; index++) {
        const y = padTop + (plotHeight / lines) * index
        context.strokeStyle = 'rgba(255,255,255,0.055)'
        context.lineWidth = 1
        context.beginPath()
        context.moveTo(padLeft, Math.round(y) + 0.5)
        context.lineTo(padLeft + plotWidth, Math.round(y) + 0.5)
        context.stroke()

        const value = max - (max / lines) * index
        context.fillStyle = 'rgba(255,255,255,0.34)'
        context.textAlign = 'right'
        const text = max >= 100 ? Math.round(value).toString() : value.toFixed(max >= 10 ? 0 : 1)
        context.fillText(`${text}${unit}`, padLeft - 7, y)
      }
    }

    const xFor = (index: number) => padLeft + (plotWidth / Math.max(1, capacity - 1)) * index
    const yFor = (value: number) => padTop + plotHeight - (Math.min(value, max) / max) * plotHeight

    for (const line of series) {
      // Right-align the samples so a partially filled buffer grows from the right.
      const offset = capacity - line.values.length

      if (line.fill !== false) {
        context.beginPath()
        let open = false
        for (let index = 0; index < line.values.length; index++) {
          const value = line.values[index]
          const x = xFor(index + offset)
          if (value === null || value === undefined || !Number.isFinite(value)) {
            if (open) {
              context.lineTo(xFor(index - 1 + offset), padTop + plotHeight)
              context.closePath()
              const gradient = context.createLinearGradient(0, padTop, 0, padTop + plotHeight)
              gradient.addColorStop(0, `${line.color}44`)
              gradient.addColorStop(1, `${line.color}00`)
              context.fillStyle = gradient
              context.fill()
              open = false
            }
            continue
          }
          if (!open) {
            context.beginPath()
            context.moveTo(x, padTop + plotHeight)
            context.lineTo(x, yFor(value))
            open = true
          } else {
            context.lineTo(x, yFor(value))
          }
        }
        if (open) {
          context.lineTo(xFor(line.values.length - 1 + offset), padTop + plotHeight)
          context.closePath()
          const gradient = context.createLinearGradient(0, padTop, 0, padTop + plotHeight)
          gradient.addColorStop(0, `${line.color}44`)
          gradient.addColorStop(1, `${line.color}00`)
          context.fillStyle = gradient
          context.fill()
        }
      }

      context.strokeStyle = line.color
      context.lineWidth = 1.8
      context.lineJoin = 'round'
      context.lineCap = 'round'
      context.beginPath()
      let drawing = false
      for (let index = 0; index < line.values.length; index++) {
        const value = line.values[index]
        if (value === null || value === undefined || !Number.isFinite(value)) {
          drawing = false
          continue
        }
        const x = xFor(index + offset)
        const y = yFor(value)
        if (!drawing) {
          context.moveTo(x, y)
          drawing = true
        } else {
          context.lineTo(x, y)
        }
      }
      context.stroke()

      // Head marker on the newest sample.
      const lastIndex = line.values.length - 1
      const last = line.values[lastIndex]
      if (last !== null && last !== undefined && Number.isFinite(last)) {
        const x = xFor(lastIndex + offset)
        const y = yFor(last)
        context.fillStyle = line.color
        context.beginPath()
        context.arc(x, y, 2.6, 0, Math.PI * 2)
        context.fill()
        context.globalAlpha = 0.25
        context.beginPath()
        context.arc(x, y, 6, 0, Math.PI * 2)
        context.fill()
        context.globalAlpha = 1
      }
    }
  }, [series, height, capacity, yMax, unit, grid])

  return (
    <div className="chart" style={{ height }}>
      <canvas ref={canvasRef} style={{ height }} />
    </div>
  )
}

/** Tiny inline trend line used inside stat tiles. */
export function Sparkline({ values, color, height = 34 }: { values: (number | null)[]; color: string; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const ratio = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    if (width === 0) return
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    if (values.length < 2) return

    const finite = values.filter((v): v is number => v !== null && Number.isFinite(v))
    if (finite.length === 0) return
    const max = Math.max(...finite, 1)

    const xFor = (index: number) => (width / Math.max(1, values.length - 1)) * index
    const yFor = (value: number) => height - 2 - (value / max) * (height - 4)

    context.beginPath()
    let drawing = false
    for (let index = 0; index < values.length; index++) {
      const value = values[index]
      if (value === null || value === undefined || !Number.isFinite(value)) {
        drawing = false
        continue
      }
      const x = xFor(index)
      const y = yFor(value)
      if (!drawing) {
        context.moveTo(x, y)
        drawing = true
      } else {
        context.lineTo(x, y)
      }
    }
    context.strokeStyle = color
    context.lineWidth = 1.4
    context.stroke()

    context.lineTo(xFor(values.length - 1), height)
    context.lineTo(xFor(0), height)
    context.closePath()
    const gradient = context.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, `${color}38`)
    gradient.addColorStop(1, `${color}00`)
    context.fillStyle = gradient
    context.fill()
  }, [values, color, height])

  return (
    <div className="stat__spark" style={{ height }}>
      <canvas ref={canvasRef} style={{ height, width: '100%' }} />
    </div>
  )
}
