import { useFrame } from '@react-three/fiber'
import { useCallback, useEffect, useRef } from 'react'
import type { Track, Tubes as TubesData } from '../types'
import { loopPositions, tubeLoops, type Sampling } from './geometry'
import { disposeLines, makeLines } from './lines'
import { approach, FADE_TAU, reveal } from './motion'
import { trackColor, TUBE_WIDTH, type Space } from './space'
import { tubeOpacity, useHighlight } from './useHighlight'
import { useTrackObjects } from './useTrackObjects'

export const trackOpacity = new Map<number, number>()

export function Tubes({ tubes, space, sampling }: { tubes: TubesData; space: Space; sampling: Sampling }) {
  const build = useCallback(
    (track: Track) =>
      makeLines({ positions: loopPositions(tubeLoops(track, sampling), space), color: trackColor(track.id), width: TUBE_WIDTH, opacity: 0 }),
    [space, sampling],
  )
  const { group, objects } = useTrackObjects(tubes.tracks, build, disposeLines)
  const targets = useRef(new Map<number, number>())

  useEffect(() => {
    window.__tubewatch.visibleTracks = () => [...objects.current.values()].filter(({ object }) => object.visible).map(({ track }) => track.id)
    return () => trackOpacity.clear()
  }, [objects])

  const highlight = useHighlight(tubes)
  const shown = useRef(false)
  useEffect(() => {
    const showing = highlight.matched !== null
    if (showing && !shown.current) reveal.startedAt = performance.now()
    shown.current = showing
    targets.current.clear()
    for (const id of objects.current.keys()) targets.current.set(id, tubeOpacity(highlight, id))
    requestAnimationFrame(() => (window.__tubewatch.highlightAppliedAt = performance.now()))
  }, [highlight, objects])

  useFrame((_, dt) => {
    for (const [id, { object }] of objects.current) {
      const material = object.material
      const target = targets.current.get(id) ?? 0
      if (material.opacity !== target) material.opacity = approach(material.opacity, target, dt, FADE_TAU)
      object.visible = material.opacity > 0.004
      trackOpacity.set(id, material.opacity)
    }
  })

  return <group ref={group} />
}
