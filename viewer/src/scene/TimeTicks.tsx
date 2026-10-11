import { Html } from '@react-three/drei'
import { useMemo } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { clock } from '../time'
import type { Video } from '../types'
import type { Space } from './space'

const STEPS_SEC = [5, 10, 15, 20, 30, 60, 120, 300, 600]
const MAX_TICKS = 7
const TICK = 0.08

export function TimeTicks({ video, space }: { video: Video; space: Space }) {
  const introDone = useStore((s) => s.introDone)
  const ticks = useMemo(() => {
    const seconds = video.frames / video.fps
    const step = STEPS_SEC.find((s) => seconds / s <= MAX_TICKS - 1) ?? STEPS_SEC[STEPS_SEC.length - 1]!
    const out: number[] = []
    for (let t = 0; t * video.fps < video.frames; t += step) out.push(Math.round(t * video.fps))
    return out
  }, [video])

  const marks = useMemo(() => {
    const x = space.imageWidth / 2
    const y = -space.imageHeight / 2
    const positions = ticks.flatMap((f) => [x, y, space.z(f), x + TICK, y - TICK / 2, space.z(f)])
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    return g
  }, [ticks, space])

  if (!introDone) return null
  const x = space.imageWidth / 2 + TICK * 2.2
  const y = -space.imageHeight / 2 - TICK * 1.2
  return (
    <>
      <lineSegments geometry={marks} raycast={() => null}>
        <lineBasicMaterial color="#ffffff" transparent opacity={0.35} depthWrite={false} />
      </lineSegments>
      {ticks.map((f) => (
        <Html key={f} position={[x, y, space.z(f)]} center className="tick" zIndexRange={[1, 0]}>
          {clock(f, video.fps)}
        </Html>
      ))}
    </>
  )
}
