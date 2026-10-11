import * as THREE from 'three'
import type { Track, Video } from '../types'
import { tubeLoops, type Sampling } from './geometry'

export const IMAGE_WIDTH = 4.6
export const DEPTH = 10
const MIN_STRIDE = 2
const MAX_STRIDE = 12
const MOVE_FRACTION = 0.01
const MAX_GAP_SEC = 3
const SEGMENT_BUDGET = 160_000
export const FULL_OPACITY = 0.95
export const CONTEXT_OPACITY = 0.4
export const HIGHLIGHT_RED = '#ff3b30'
export const TUBE_WIDTH = 1.35

const PALETTE = [
  '#dcf26a',
  '#ff9ed2',
  '#6ef0ff',
  '#8ff5c2',
  '#c6b3ff',
  '#ffc98a',
  '#7cc8ff',
  '#f2f58a',
  '#ff9a8a',
  '#86f7e3',
]

export const trackColor = (id: number) => PALETTE[id % PALETTE.length]!

export const CUBE_YAW = -Math.PI / 4

export const cubeMatrix = new THREE.Matrix4()
  .makeRotationY(CUBE_YAW)
  .multiply(new THREE.Matrix4().makeTranslation(0, 0, DEPTH / 2))

export type Space = {
  imageWidth: number
  imageHeight: number
  x(px: number): number
  y(py: number): number
  z(f: number): number
  corners(): THREE.Vector3[]
}

// Partial data is scaled up to the whole clip, so the stride chosen from the first streamed chunk holds once every track is in.
export function samplingFor(video: Video, tracks: Track[], framesDone: number | null): Sampling {
  const base = { minMovePx: video.width * MOVE_FRACTION, maxGap: Math.round(video.fps * MAX_GAP_SEC) }
  const projection = framesDone ? video.frames / Math.max(1, framesDone) : 1
  for (let stride = MIN_STRIDE; ; stride++) {
    const sampling = { ...base, stride }
    const segments = tracks.reduce((n, t) => n + tubeLoops(t, sampling).reduce((m, fr) => m + fr.contour.length, 0), 0)
    if (segments * projection <= SEGMENT_BUDGET || stride >= MAX_STRIDE) return sampling
  }
}

export function makeSpace(video: Video): Space {
  const scale = IMAGE_WIDTH / video.width
  const spacing = DEPTH / video.frames
  const imageHeight = video.height * scale
  return {
    imageWidth: IMAGE_WIDTH,
    imageHeight,
    x: (px) => (px - video.width / 2) * scale,
    y: (py) => (video.height / 2 - py) * scale,
    z: (f) => -f * spacing,
    corners: () =>
      [-1, 1].flatMap((sx) =>
        [-1, 1].flatMap((sy) =>
          [0, -DEPTH].map((z) =>
            new THREE.Vector3((sx * IMAGE_WIDTH) / 2, (sy * imageHeight) / 2, z).applyMatrix4(cubeMatrix),
          ),
        ),
      ),
  }
}
