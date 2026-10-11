import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { growClip, intro, introPhase, revealProgress } from './motion'
import type { Space } from './space'
import { firstBatchLoaded, resumePreload } from './thumbs'

const localClip = new THREE.Plane()
const ALONG_TIME = new THREE.Vector3(0, 0, 1)

export function IntroDriver({ space, frames }: { space: Space; frames: number }) {
  const anchor = useRef<THREE.Group>(null)
  const smoothFrames = useRef(0)

  useEffect(() => {
    const skip = () => {
      if (!introPhase(performance.now()).done) intro.skipped = true
    }
    window.addEventListener('pointerdown', skip)
    return () => window.removeEventListener('pointerdown', skip)
  }, [])

  useFrame((_, dt) => {
    const now = performance.now()
    smoothFrames.current = dt < 0.022 ? smoothFrames.current + 1 : 0
    if (intro.startedAt === null && !intro.skipped && smoothFrames.current > 8 && firstBatchLoaded()) {
      intro.startedAt = now
      window.__tubewatch.introStartedAt = now
    }
    const grown = revealProgress(now)
    if (grown >= 1) {
      growClip.set(ALONG_TIME, 1e6)
    } else if (anchor.current) {
      localClip.set(ALONG_TIME, -space.z(grown * frames))
      growClip.copy(localClip).applyMatrix4(anchor.current.matrixWorld)
    }
    if (introPhase(now).done && !useStore.getState().introDone) {
      useStore.getState().finishIntro()
      setTimeout(resumePreload, 800)
    }
  })

  return <group ref={anchor} />
}
