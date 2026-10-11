import type { Px, Track, TrackFrame } from '../types'
import type { Space } from './space'

export function loopPositions(frames: TrackFrame[], space: Space, z = (f: number) => space.z(f)): number[] {
  const out: number[] = []
  for (const frame of frames) pushLoop(out, frame.contour, space, z(frame.f))
  return out
}

export function pushLoop(out: number[], contour: Px[], space: Space, z: number) {
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i]!
    const b = contour[(i + 1) % contour.length]!
    out.push(space.x(a[0]), space.y(a[1]), z, space.x(b[0]), space.y(b[1]), z)
  }
}

export type Sampling = { stride: number; minMovePx: number; maxGap: number }

export function tubeLoops(track: Track, sampling: Sampling): TrackFrame[] {
  const out: TrackFrame[] = []
  let last: TrackFrame | undefined
  for (const fr of track.frames) {
    if (fr.f % sampling.stride !== 0) continue
    const moved = last ? Math.hypot(fr.centroid[0] - last.centroid[0], fr.centroid[1] - last.centroid[1]) : Infinity
    if (!last || moved >= sampling.minMovePx || fr.f - last.f >= sampling.maxGap) {
      out.push(fr)
      last = fr
    }
  }
  return out
}

export function frameAt(track: Track, f: number): TrackFrame | undefined {
  if (f < track.first_frame || f > track.last_frame) return undefined
  const guess = track.frames[f - track.first_frame]
  if (guess?.f === f) return guess
  return track.frames.find((fr) => fr.f === f)
}
