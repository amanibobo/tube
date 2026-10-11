import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { Segment, Track, Tubes } from '../types'
import { loopPositions, tubeLoops, type Sampling } from './geometry'
import { disposeLines, makeLines } from './lines'
import { approach } from './motion'
import type { Space } from './space'
import { useHighlight } from './useHighlight'

function segmentFrames(track: Track, seg: Segment, sampling: Sampling) {
  const inRange = (f: number) => f >= seg.f_start && f <= seg.f_end
  const loops = tubeLoops(track, sampling).filter((fr) => inRange(fr.f))
  if (loops.length > 0) return loops
  const inside = track.frames.filter((fr) => inRange(fr.f))
  return inside.length > 0 ? [inside[Math.floor(inside.length / 2)]!] : []
}

export function HighlightLines({ tubes, space, sampling }: { tubes: Tubes; space: Space; sampling: Sampling }) {
  const { segments } = useHighlight(tubes)
  const pair = useMemo(() => {
    const byId = new Map(tubes.tracks.map((t) => [t.id, t]))
    const positions: number[] = []
    const colors: number[] = []
    const color = new THREE.Color()
    for (const seg of segments) {
      const track = byId.get(seg.track_id)
      if (!track) continue
      const flat = loopPositions(segmentFrames(track, seg, sampling), space)
      color.set(seg.color)
      for (let i = 0; i < flat.length; i += 3) colors.push(color.r, color.g, color.b)
      positions.push(...flat)
    }
    if (positions.length === 0) return null
    return {
      core: makeLines({ positions, colors, width: 2.2, opacity: 0, renderOrder: 3 }),
      glow: makeLines({ positions, colors, width: 5, opacity: 0, additive: true, renderOrder: 2 }),
    }
  }, [segments, tubes, space, sampling])

  useEffect(
    () => () => {
      if (pair) [pair.core, pair.glow].forEach(disposeLines)
    },
    [pair],
  )

  useFrame((_, dt) => {
    if (!pair) return
    pair.core.material.opacity = approach(pair.core.material.opacity, 1, dt)
    pair.glow.material.opacity = approach(pair.glow.material.opacity, 0.12, dt)
  })

  if (!pair) return null
  return (
    <>
      <primitive object={pair.glow} />
      <primitive object={pair.core} />
    </>
  )
}
