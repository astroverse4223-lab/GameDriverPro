import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Generates the app and tray icons as PNGs with no image dependencies.
 *
 * The mark is a hexagonal "core" with a neon ring and a rising performance
 * chevron — a GPU-shaped silhouette that still reads at 16px in the tray.
 */

const OUT_DIR = fileURLToPath(new URL('../resources/', import.meta.url))

function crc32(buffer) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const mix = (a, b, t) => a + (b - a) * t
const smooth = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** Signed distance to a regular hexagon centred at the origin. */
function hexDistance(x, y, radius) {
  const kx = -0.8660254
  const ky = 0.5
  const kz = 0.5773503
  let px = Math.abs(x)
  let py = Math.abs(y)
  const dot = Math.min(0, kx * px + ky * py) * 2
  px -= dot * kx
  py -= dot * ky
  const clampedX = Math.max(-kz * radius, Math.min(kz * radius, px))
  const dx = px - clampedX
  const dy = py - radius
  return Math.sqrt(dx * dx + dy * dy) * Math.sign(dy)
}

function drawIcon(size, { padding = 0.06, glow = true } = {}) {
  const rgba = Buffer.alloc(size * size * 4)
  const half = size / 2
  const outer = half * (1 - padding)
  const supersample = 3

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const x = px + (sx + 0.5) / supersample - half
          const y = py + (sy + 0.5) / supersample - half
          const dHexOuter = hexDistance(x, y, outer)
          const dHexInner = hexDistance(x, y, outer * 0.78)

          // Body: dark charcoal core with a vertical gradient.
          const bodyAlpha = 1 - smooth(-1.2, 1.2, dHexInner)
          const vertical = clamp01((y + outer) / (2 * outer))
          let cr = mix(18, 9, vertical)
          let cg = mix(22, 12, vertical)
          let cb = mix(38, 20, vertical)
          let ca = bodyAlpha

          // Ring: neon cyan → violet sweep around the hex edge.
          const ringWidth = outer * 0.085
          const ringDistance = Math.abs(dHexOuter + ringWidth * 0.6)
          const ringAlpha = 1 - smooth(ringWidth * 0.35, ringWidth * 0.9, ringDistance)
          const angle = (Math.atan2(y, x) + Math.PI) / (2 * Math.PI)
          const sweep = 0.5 + 0.5 * Math.cos((angle - 0.15) * Math.PI * 2)
          const rr = mix(120, 34, sweep)
          const rg = mix(70, 224, sweep)
          const rb = mix(255, 236, sweep)

          if (ringAlpha > 0) {
            const t = ringAlpha
            cr = mix(cr, rr, t)
            cg = mix(cg, rg, t)
            cb = mix(cb, rb, t)
            ca = Math.max(ca, t)
          }

          // Two stacked upward chevrons: a rising performance mark.
          const cx = x / outer
          const cy = y / outer
          const inCore = dHexInner < -outer * 0.04
          if (inCore && Math.abs(cx) < 0.66) {
            for (const [offset, strength] of [
              [0.02, 1],
              [0.42, glow ? 0.55 : 0.75]
            ]) {
              const strokeHalf = 0.1
              const chevron = Math.abs(cy - 0.85 * Math.abs(cx) + 0.24 - offset) - strokeHalf
              const alpha = (1 - smooth(0, 0.055, chevron)) * strength
              if (alpha > 0.01 && cy - 0.85 * Math.abs(cx) + 0.24 - offset > -0.6) {
                cr = mix(cr, 214, alpha)
                cg = mix(cg, 248, alpha)
                cb = mix(cb, 255, alpha)
                ca = Math.max(ca, alpha)
              }
            }
          }

          r += cr * ca
          g += cg * ca
          b += cb * ca
          a += ca
        }
      }

      const samples = supersample * supersample
      const alpha = a / samples
      const index = (py * size + px) * 4
      // r/g/b accumulate premultiplied 0–255 channel values; un-premultiply
      // against the averaged alpha and clamp to the byte range.
      const channel = (value) => (alpha > 0 ? Math.round(Math.max(0, Math.min(255, value / samples / alpha))) : 0)
      rgba[index] = channel(r)
      rgba[index + 1] = channel(g)
      rgba[index + 2] = channel(b)
      rgba[index + 3] = Math.round(clamp01(alpha) * 255)
    }
  }
  return encodePng(size, size, rgba)
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(new URL('icon.png', `file://${OUT_DIR.replace(/\\/g, '/')}`), drawIcon(256))
writeFileSync(new URL('tray.png', `file://${OUT_DIR.replace(/\\/g, '/')}`), drawIcon(64, { padding: 0.02, glow: false }))
console.log('  icons written to', OUT_DIR)
