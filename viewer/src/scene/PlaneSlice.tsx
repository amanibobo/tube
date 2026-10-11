import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import type { Track, Tubes } from '../types'
import { frameAt, pushLoop } from './geometry'
import { disposeLines, makeLines } from './lines'
import { FULL_OPACITY, trackColor, type Space } from './space'
import { trackOpacity } from './Tubes'
import { useHighlight } from './useHighlight'
import { useTrackObjects } from './useTrackObjects'

const LIFT = 0.004

const build = (track: Track) =>
  makeLines({ positions: [0, 0, 0, 0, 0, 0], color: trackColor(track.id), width: 1.8, clip: false, renderOrder: 4 })

export function PlaneSlice({ tubes, space, frame }: { tubes: Tubes; space: Space; frame: number }) {
  const highlight = useHighlight(tubes)
  const { group, objects } = useTrackObjects(tubes.tracks, build, disposeLines)
  useEffect(() => {
    window.__tubewatch.visibleSlices = () => [...objects.current.values()].filter(({ object }) => object.visible).map(({ track }) => track.id)
  }, [objects])

  const hasContour = useRef(new Set<number>())
  useEffect(() => {
    hasContour.current.clear()
    for (const { track, object: line } of objects.current.values()) {
      const tf = frameAt(track, frame)
      if (!tf) continue
      hasContour.current.add(track.id)
      const positions: number[] = []
      pushLoop(positions, tf.contour, space, LIFT)
      line.geometry.setPositions(positions)
      const red = highlight.segments.find((s) => s.track_id === track.id && frame >= s.f_start && frame <= s.f_end)
      line.material.color.set(red ? red.color : trackColor(track.id))
    }
  }, [objects, frame, space, highlight, tubes])

  useFrame(() => {
    for (const { track, object: line } of objects.current.values()) {
      const opacity = Math.min(1, (trackOpacity.get(track.id) ?? 0) / FULL_OPACITY)
      line.material.opacity = opacity
      line.visible = opacity > 0.004 && hasContour.current.has(track.id)
    }
  })

  return <group ref={group} />
}
