import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Tubes as TubesData, VideoId } from '../types'
import { CameraRig } from './CameraRig'
import type { Sampling } from './geometry'
import { FramePlane } from './FramePlane'
import { HighlightLines } from './HighlightLines'
import { IntroDriver } from './IntroDriver'
import { introPhase } from './motion'
import { cubeMatrix, DEPTH, makeSpace, type Space } from './space'
import { preloadThumbs, volumeFrames } from './thumbs'
import { TimeTicks } from './TimeTicks'
import { Tubes } from './Tubes'
import { VideoVolume, VOLUME_SLICES } from './VideoVolume'

function Outline({ space }: { space: Space }) {
  const material = useRef<THREE.LineBasicMaterial>(null)
  const edges = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(space.imageWidth, space.imageHeight, DEPTH)),
    [space],
  )
  useFrame(() => {
    if (material.current) material.current.opacity = 0.14 * introPhase(performance.now()).fade
  })
  return (
    <lineSegments geometry={edges} position-z={-DEPTH / 2} raycast={() => null}>
      <lineBasicMaterial ref={material} color="#ffffff" transparent opacity={0} depthWrite={false} />
    </lineSegments>
  )
}

function FpsProbe() {
  const acc = useRef({ frames: 0, time: 0 })
  useFrame((_, delta) => {
    acc.current.frames++
    acc.current.time += delta
    if (acc.current.time >= 1) {
      window.__tubewatch.fps = acc.current.frames / acc.current.time
      window.__tubewatch.frameMs = (acc.current.time / acc.current.frames) * 1000
      acc.current = { frames: 0, time: 0 }
    }
  })
  return null
}

export function Cube({ videoId, tubes, sampling }: { videoId: VideoId; tubes: TubesData; sampling: Sampling | null }) {
  const video = tubes.video
  const space = useMemo(() => makeSpace(video), [video])
  useEffect(() => preloadThumbs(videoId, video, [0, ...volumeFrames(video, VOLUME_SLICES)]), [videoId, video])

  return (
    <Canvas
      className="cube"
      dpr={[1, 2]}
      camera={{ fov: 32, near: 0.05, far: 200 }}
      gl={{ antialias: true }}
      onCreated={({ gl }) => {
        gl.setClearColor('#050505')
        gl.localClippingEnabled = true
      }}
    >
      <group matrix={cubeMatrix} matrixAutoUpdate={false}>
        <IntroDriver space={space} frames={tubes.video.frames} />
        <Outline space={space} />
        <TimeTicks video={tubes.video} space={space} />
        <VideoVolume tubes={tubes} space={space} />
        {sampling && <Tubes tubes={tubes} space={space} sampling={sampling} />}
        {sampling && <HighlightLines tubes={tubes} space={space} sampling={sampling} />}
        <FramePlane tubes={tubes} space={space} />
      </group>
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} enablePan={false} rotateSpeed={0.6} zoomSpeed={0.7} />
      <CameraRig space={space} />
      <FpsProbe />
    </Canvas>
  )
}
