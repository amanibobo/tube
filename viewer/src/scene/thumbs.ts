import { api } from '../api'
import type { Video, VideoId } from '../types'

const MAX_THUMBS = 600
const CONCURRENCY = 6

let bitmaps = new Map<number, ImageBitmap>()
let ready: number[] = []
const listeners = new Set<() => void>()
let videoId: VideoId | null = null
let firstBatch = new Set<number>()

export const firstBatchLoaded = () => videoId !== null && [...firstBatch].every((f) => bitmaps.has(f))

export function onThumbs(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function hasThumb(f: number) {
  return bitmaps.has(f)
}

export function nearestThumb(f: number): { f: number; bitmap: ImageBitmap } | null {
  if (ready.length === 0) return null
  let lo = 0
  let hi = ready.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ready[mid]! < f) lo = mid + 1
    else hi = mid
  }
  const best = lo > 0 && f - ready[lo - 1]! < ready[lo]! - f ? ready[lo - 1]! : ready[lo]!
  return { f: best, bitmap: bitmaps.get(best)! }
}

export function volumeFrames(video: Video, count: number): number[] {
  const step = video.thumb_stride
  const last = Math.floor((video.frames - 1) / step) * step
  return Array.from({ length: count }, (_, i) => Math.round(((i / (count - 1)) * last) / step) * step)
}

function loadOrder(video: Video, first: number[]): number[] {
  const all: number[] = []
  const stride = video.thumb_stride * Math.max(1, Math.ceil(video.frames / video.thumb_stride / MAX_THUMBS))
  for (let f = 0; f < video.frames; f += stride) all.push(f)
  const seen = new Set<number>(first)
  const order = [...first]
  for (let level = 64; level >= 1; level >>= 1) {
    for (let i = 0; i < all.length; i += level) {
      const f = all[i]!
      if (!seen.has(f)) {
        seen.add(f)
        order.push(f)
      }
    }
  }
  return order
}

async function load(id: VideoId, f: number, into: Map<number, ImageBitmap>) {
  const blob = await fetch(api.frameUrl(id, f)).then((r) => r.blob())
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' })
  if (into !== bitmaps) return bitmap.close()
  bitmaps.set(f, bitmap)
  ready = [...bitmaps.keys()].sort((a, b) => a - b)
  listeners.forEach((l) => l())
}

let release: () => void = () => {}
let released = Promise.resolve()

export const resumePreload = () => release()

export function preloadThumbs(id: VideoId, video: Video, first: number[]) {
  if (videoId === id) return
  videoId = id
  bitmaps.forEach((b) => b.close())
  const mine = new Map<number, ImageBitmap>()
  bitmaps = mine
  ready = []
  release()
  released = new Promise<void>((resolve) => (release = resolve))
  const gate = released
  firstBatch = new Set(first)
  const queue = loadOrder(video, first)
  const worker = async () => {
    for (let f = queue.shift(); f !== undefined && bitmaps === mine; f = queue.shift()) {
      if (!firstBatch.has(f)) await gate
      if (bitmaps === mine) await load(id, f, mine).catch(() => {})
    }
  }
  for (let i = 0; i < CONCURRENCY; i++) void worker()
}
