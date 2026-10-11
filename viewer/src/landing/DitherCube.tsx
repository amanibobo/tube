import { useEffect, useRef } from 'react'

type Ink = [number, number, number]

const SRC_W = 1200
const SRC_H = 560

/** Box size in frame units (16:9) and its oblique projection: time recedes up and to the right. */
const FW = 16
const FH = 9
const UNIT = 26
const ORIGIN = { x: 40, y: 296 }
const DEPTH = { x: 660, y: -160 }

type Shape = 'car' | 'person' | 'bike'
interface Tube {
  shape: Shape
  color: number
  t0: number
  t1: number
  at: (u: number) => [number, number]
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u

/** A small scene with a story: two cars pass, a parked car runs the whole clip, and one person crosses as a car goes by. */
const TUBES: Tube[] = [
  { shape: 'car', color: 2, t0: 0.04, t1: 0.46, at: (u) => [lerp(1.5, 13, u), 5.4] },
  { shape: 'car', color: 1, t0: 0.38, t1: 0.8, at: (u) => [lerp(14.5, 2, u), 3.2] },
  { shape: 'car', color: 0, t0: 0, t1: 1, at: () => [11.5, 7.6] },
  { shape: 'person', color: 5, t0: 0.48, t1: 0.82, at: (u) => [lerp(7.2, 7.8, u), lerp(1.2, 8.2, u)] },
  { shape: 'person', color: 4, t0: 0.58, t1: 0.96, at: (u) => [lerp(2, 9.5, u), 0.9] },
  { shape: 'bike', color: 3, t0: 0.68, t1: 0.98, at: (u) => [lerp(2.5, 15, u), 4.4] },
]

/** The close pass between the crossing person and the second car, drawn red like an answer in the app. */
const NEAR_MISS = { t: 0.6, half: 0.045, tubes: new Set([1, 3]) }

/** Tube colors, then the near-miss red. Pixels left white in the color layer fall back to ink. */
export type Palette = [string, string, string, string, string, string, string]

const SIZE: Record<Shape, [number, number]> = { car: [3, 1.6], person: [0.8, 1.3], bike: [1.6, 0.7] }

function project(x: number, y: number, t: number): [number, number] {
  return [ORIGIN.x + x * UNIT + t * DEPTH.x, ORIGIN.y + y * UNIT + t * DEPTH.y]
}

function polygon(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.closePath()
}

function outline(ctx: CanvasRenderingContext2D, shape: Shape, cx: number, cy: number, t: number) {
  const [w, h] = SIZE[shape]
  const pts: [number, number][] = []
  const n = 24
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    // cars are rounded boxes, people and bikes ellipses
    const k = shape === 'car' ? 0.28 : 1
    const sx = Math.sign(Math.cos(a)) * Math.abs(Math.cos(a)) ** k
    const sy = Math.sign(Math.sin(a)) * Math.abs(Math.sin(a)) ** k
    pts.push(project(cx + (sx * w) / 2, cy + (sy * h) / 2, t))
  }
  polygon(ctx, pts)
}

function shade(d: number) {
  const v = Math.round(255 * (1 - d))
  return `rgb(${v}, ${v}, ${v})`
}

/**
 * Sweeps each tube from far to near as solid stacked shapes; every few steps a light ring is cut in,
 * so after dithering the tube reads as stacked outlines rather than a flat smear.
 */
function tubeColor(palette: Palette, index: number, t: number) {
  const near = NEAR_MISS.tubes.has(index) && Math.abs(t - NEAR_MISS.t) < NEAR_MISS.half
  return palette[near ? 6 : TUBES[index]!.color]!
}

function sweep(
  ctx: CanvasRenderingContext2D,
  keep: (t: number) => boolean,
  body: number,
  ring: number,
  palette?: Palette,
) {
  ctx.lineWidth = 1.6
  TUBES.forEach((tube, index) => {
    const span = tube.t1 - tube.t0 || 1
    let i = 0
    for (let t = tube.t1; t >= tube.t0; t -= 0.006, i++) {
      if (!keep(t)) continue
      const [x, y] = tube.at((t - tube.t0) / span)
      outline(ctx, tube.shape, x, y, t)
      ctx.fillStyle = palette ? tubeColor(palette, index, t) : shade(body)
      ctx.fill()
      if (!palette && i % 4 === 0) {
        ctx.strokeStyle = shade(ring)
        ctx.stroke()
      }
    }
  })
}

/**
 * Paints the cube with the frame plane at time `p`: a grayscale darkness field, or with a palette,
 * the color layer (tube colors on white) that tints the dashes.
 */
function paintSource(ctx: CanvasRenderingContext2D, p: number, palette?: Palette) {
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, SRC_W, SRC_H)
  ctx.lineJoin = 'round'
  const c = (x: number, y: number, t: number) => project(x, y, t)

  // a faint dust for the video smeared along time, just above the dither threshold
  if (!palette) {
    ctx.fillStyle = shade(0.13)
    polygon(ctx, [c(0, 0, 0), c(0, 0, 1), c(FW, 0, 1), c(FW, FH, 1), c(FW, FH, 0), c(0, FH, 0)])
    ctx.fill()
  }

  sweep(ctx, (t) => t > p, 0.5, 0.12, palette)

  // the frame plane: a solid slab with the road and crosswalk on it, so it reads as a video frame
  const plane: [number, number][] = [c(0, 0, p), c(FW, 0, p), c(FW, FH, p), c(0, FH, p)]
  ctx.fillStyle = palette ? '#fff' : shade(0.5)
  polygon(ctx, plane)
  ctx.fill()
  if (palette) {
    TUBES.forEach((tube, index) => {
      if (p < tube.t0 || p > tube.t1) return
      const [x, y] = tube.at((p - tube.t0) / (tube.t1 - tube.t0 || 1))
      outline(ctx, tube.shape, x, y, p)
      ctx.strokeStyle = tubeColor(palette, index, p)
      ctx.lineWidth = 3
      ctx.stroke()
    })
    sweep(ctx, (t) => t < p, 0, 0, palette)
    return
  }
  ctx.fillStyle = shade(0.86)
  polygon(ctx, [c(0, FH * 0.3, p), c(FW, FH * 0.3, p), c(FW, FH * 0.7, p), c(0, FH * 0.7, p)])
  ctx.fill()
  ctx.fillStyle = shade(0.05)
  for (let i = 0; i < 6; i++) {
    const x = 6.2 + i * 0.6
    polygon(ctx, [c(x, FH * 0.32, p), c(x + 0.3, FH * 0.32, p), c(x + 0.3, FH * 0.68, p), c(x, FH * 0.68, p)])
    ctx.fill()
  }
  ctx.strokeStyle = shade(1)
  ctx.lineWidth = 4
  polygon(ctx, plane)
  ctx.stroke()

  // each tube's slice on the plane as a white cutout with a dark rim, then the diamond handle
  for (const tube of TUBES) {
    if (p < tube.t0 || p > tube.t1) continue
    const [x, y] = tube.at((p - tube.t0) / (tube.t1 - tube.t0 || 1))
    outline(ctx, tube.shape, x, y, p)
    ctx.fillStyle = shade(0)
    ctx.fill()
    ctx.strokeStyle = shade(1)
    ctx.lineWidth = 3
    ctx.stroke()
  }
  const [hx, hy] = c(FW / 2, 0, p)
  ctx.fillStyle = shade(1)
  polygon(ctx, [[hx, hy - 40], [hx + 14, hy - 26], [hx, hy - 12], [hx - 14, hy - 26]])
  ctx.fill()

  sweep(ctx, (t) => t < p, 0.95, 0.3)

  // box edges last, so the cube reads as one object
  ctx.strokeStyle = shade(0.8)
  ctx.lineWidth = 4
  const faces: [number, number, number][][] = [
    [[0, 0, 0], [FW, 0, 0], [FW, FH, 0], [0, FH, 0]],
    [[0, 0, 1], [FW, 0, 1], [FW, FH, 1], [0, FH, 1]],
  ]
  for (const f of faces) {
    polygon(ctx, f.map(([x, y, t]) => c(x, y, t)))
    ctx.stroke()
  }
  const corners: [number, number][] = [[0, 0], [FW, 0], [FW, FH], [0, FH]]
  for (const [x, y] of corners) {
    polygon(ctx, [c(x, y, 0), c(x, y, 1)])
    ctx.stroke()
  }
}

/**
 * The space-time cube drawn as horizontal ink dashes whose density follows the darkness of a
 * painted source, the way a plotter would shade it. The frame plane drifts through time and the
 * dash field is re-jittered a few times a second; under reduced motion it is drawn once.
 */
export function DitherCube({ ink, palette }: { ink: Ink; palette: Palette }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const look = useRef({ ink, palette })
  const redraw = useRef<() => void>(() => {})

  useEffect(() => {
    look.current = { ink, palette }
    redraw.current()
  }, [ink, palette])

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const off = document.createElement('canvas')
    const octx = off.getContext('2d', { willReadFrequently: true })
    const tint = document.createElement('canvas')
    const tctx = tint.getContext('2d', { willReadFrequently: true })
    if (!octx || !tctx) return
    let gw = 0
    let gh = 0
    let cw = 0
    let ch = 0
    let seed = 1
    let timer = 0
    let raf = 0
    const start = performance.now()

    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const box = canvas.getBoundingClientRect()
      cw = Math.max(1, Math.round(box.width * dpr))
      ch = Math.max(1, Math.round(((box.width * SRC_H) / SRC_W) * dpr))
      canvas.width = cw
      canvas.height = ch
      canvas.style.height = `${ch / dpr}px`
      gw = Math.min(560, Math.max(300, Math.floor(box.width / 2)))
      gh = Math.max(1, Math.round((gw * SRC_H) / SRC_W / 1.7))
      off.width = tint.width = gw
      off.height = tint.height = gh
    }

    const planeAt = (ms: number) => (reduce ? 0.5 : 0.5 - 0.34 * Math.cos((ms / 22000) * Math.PI * 2))

    const draw = (ms: number) => {
      const p = planeAt(ms - start)
      octx.setTransform(gw / SRC_W, 0, 0, gh / SRC_H, 0, 0)
      paintSource(octx, p)
      tctx.setTransform(gw / SRC_W, 0, 0, gh / SRC_H, 0, 0)
      paintSource(tctx, p, look.current.palette)
      const px = octx.getImageData(0, 0, gw, gh).data
      const col = tctx.getImageData(0, 0, gw, gh).data
      const lum = new Float32Array(gw * gh)
      for (let i = 0; i < gw * gh; i++) lum[i] = 1 - (px[i * 4] ?? 255) / 255

      seed = Math.floor(ms * 7919) % 2147483647 || 1
      ctx.clearRect(0, 0, cw, ch)
      const [r, g, b] = look.current.ink
      const cellW = cw / gw
      const cellH = ch / gh
      const rowH = Math.max(1, cellH * 0.42)
      for (let y = 0; y < gh; y++) {
        const yy = y * cellH + cellH * 0.3
        let x = 0
        while (x < gw) {
          const d = lum[y * gw + x] ?? 0
          if (d < 0.1 || rand() > d * 0.72) {
            x += 1
            continue
          }
          const len = Math.max(1, Math.round(1 + d * 4 + rand() * 3 * d))
          let sum = 0
          for (let k = 0; k < len && x + k < gw; k++) sum += lum[y * gw + x + k] ?? 0
          const alpha = Math.min(0.95, 0.3 + (sum / len) * 0.7)
          // a dash takes the color under its middle; white there means plain ink
          const m = (y * gw + Math.min(gw - 1, x + (len >> 1))) * 4
          const cr = col[m] ?? 255
          const cg = col[m + 1] ?? 255
          const cb = col[m + 2] ?? 255
          const plain = cr > 245 && cg > 245 && cb > 245
          ctx.fillStyle = plain
            ? `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
            : `rgba(${cr}, ${cg}, ${cb}, ${Math.min(1, alpha + 0.1).toFixed(3)})`
          ctx.fillRect(x * cellW + (rand() - 0.5) * cellW * 0.6, yy, len * cellW - cellW * 0.45, rowH)
          x += len + 1 + Math.floor(rand() * 3)
        }
      }
    }

    redraw.current = () => draw(performance.now())
    size()
    draw(start)
    if (!reduce) timer = window.setInterval(() => (raf = requestAnimationFrame(draw)), 140)
    const onResize = () => {
      size()
      draw(performance.now())
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.clearInterval(timer)
      cancelAnimationFrame(raf)
      redraw.current = () => {}
    }
  }, [])

  return <canvas ref={ref} className="lp-canvas" role="img" aria-label="A space-time cube of a street, drawn in ink dashes" />
}
