import { Html } from '@react-three/drei'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { clock } from '../time'
import type { Tubes } from '../types'
import { disposeLines, makeLines } from './lines'
import { introPhase } from './motion'
import { planeMaterial } from './planeMaterial'
import { PlaneSlice } from './PlaneSlice'
import type { Space } from './space'
import { nearestThumb } from './thumbs'

type Controls = { enabled: boolean } | null

const setCursor = (cursor: string) => (document.body.style.cursor = cursor)

function useScrubDrag(space: Space, frames: number, plane: React.RefObject<THREE.Group | null>) {
  const { camera, gl } = useThree()
  const controls = useThree((s) => s.controls) as Controls

  return (e: ThreeEvent<PointerEvent>) => {
    const parent = plane.current?.parent
    if (!parent || !introPhase(performance.now()).done) return
    e.stopPropagation()
    const rect = gl.domElement.getBoundingClientRect()
    const toScreen = (z: number) => {
      const p = new THREE.Vector3(0, space.imageHeight / 2, z).applyMatrix4(parent.matrixWorld).project(camera)
      return new THREE.Vector2(((p.x + 1) / 2) * rect.width, ((1 - p.y) / 2) * rect.height)
    }
    const a = toScreen(space.z(0))
    const ab = toScreen(space.z(frames - 1)).sub(a)
    const along = (ev: PointerEvent) =>
      new THREE.Vector2(ev.clientX - rect.left, ev.clientY - rect.top).sub(a).dot(ab) / ab.lengthSq()

    const t0 = along(e.nativeEvent)
    const store = useStore.getState()
    const f0 = store.frame
    store.setScrubbing(true)
    const move = (ev: PointerEvent) => useStore.getState().setFrame(f0 + (along(ev) - t0) * (frames - 1), 'scene')
    const up = () => {
      window.removeEventListener('pointermove', move)
      if (controls) controls.enabled = true
      useStore.getState().setScrubbing(false)
      setCursor('')
    }
    if (controls) controls.enabled = false
    setCursor('grabbing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }
}

function useFrameTexture() {
  const texture = useMemo(() => {
    const t = new THREE.Texture()
    t.flipY = false
    t.colorSpace = THREE.SRGBColorSpace
    t.generateMipmaps = false
    t.minFilter = THREE.LinearFilter
    return t
  }, [])
  const shown = useRef(-1)
  useEffect(() => () => texture.dispose(), [texture])
  useFrame(() => {
    const thumb = nearestThumb(useStore.getState().frame)
    if (!thumb || thumb.f === shown.current) return
    shown.current = thumb.f
    texture.image = thumb.bitmap
    texture.needsUpdate = true
  })
  return texture
}

const worldPos = new THREE.Vector3()
const worldQuat = new THREE.Quaternion()
const parentQuat = new THREE.Quaternion()
const screenPos = new THREE.Vector3()
const screenQuat = new THREE.Quaternion()
const inverse = new THREE.Matrix4()

export function FramePlane({ tubes, space }: { tubes: Tubes; space: Space }) {
  const frame = useStore((s) => s.frame)
  const introDone = useStore((s) => s.introDone)
  const texture = useFrameTexture()
  const material = useMemo(() => planeMaterial(texture), [texture])
  const group = useRef<THREE.Group>(null)
  const startDrag = useScrubDrag(space, tubes.video.frames, group)
  const { camera, gl } = useThree()
  const handleY = space.imageHeight / 2 + 0.2

  const edge = useMemo(() => {
    const [w, h] = [space.imageWidth / 2, space.imageHeight / 2]
    const corners = [-w, -h, w, -h, w, h, -w, h]
    const positions: number[] = []
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      positions.push(corners[i * 2]!, corners[i * 2 + 1]!, 0.002, corners[j * 2]!, corners[j * 2 + 1]!, 0.002)
    }
    return makeLines({ positions, color: '#ffffff', width: 1, opacity: 0.55, clip: false, renderOrder: 4 })
  }, [space])
  useEffect(() => () => disposeLines(edge), [edge])

  useFrame(({ camera }) => {
    const g = group.current
    if (!g?.parent) return
    const z = space.z(useStore.getState().frame)
    const { fly } = introPhase(performance.now())
    if (fly >= 1) {
      g.position.set(0, 0, z)
      g.quaternion.identity()
      return
    }
    const cam = camera as THREE.PerspectiveCamera
    const tan = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))
    const dist = Math.min(space.imageHeight / (2 * tan), space.imageWidth / (2 * tan * cam.aspect))
    screenPos.set(0, 0, 0.5).unproject(cam).sub(cam.position).normalize().multiplyScalar(dist).add(cam.position)
    screenQuat.copy(cam.quaternion)
    g.parent.updateWorldMatrix(true, false)
    worldPos.set(0, 0, z).applyMatrix4(g.parent.matrixWorld)
    g.parent.getWorldQuaternion(parentQuat)
    worldPos.lerpVectors(screenPos, worldPos, fly)
    worldQuat.slerpQuaternions(screenQuat, parentQuat, fly)
    g.position.copy(worldPos.applyMatrix4(inverse.copy(g.parent.matrixWorld).invert()))
    g.quaternion.copy(parentQuat.invert().multiply(worldQuat))
  })

  useEffect(() => {
    const toScreen = (x: number, y: number) => {
      const rect = gl.domElement.getBoundingClientRect()
      const p = new THREE.Vector3(x, y, 0).applyMatrix4(group.current!.matrixWorld).project(camera)
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
    }
    window.__tubewatch.handleScreen = () => toScreen(0, handleY)
  })

  const hover = (cursor: string) => () => document.body.style.cursor !== 'grabbing' && setCursor(cursor)

  return (
    <group ref={group}>
      <mesh
        material={material}
        renderOrder={0.5}
        onPointerDown={startDrag}
        onPointerOver={hover('grab')}
        onPointerOut={hover('')}
      >
        <planeGeometry args={[space.imageWidth, space.imageHeight]} />
      </mesh>
      <primitive object={edge} />
      <mesh position-y={handleY} rotation-z={Math.PI / 4} renderOrder={4} onPointerDown={startDrag} onPointerOver={hover('grab')} onPointerOut={hover('')}>
        <planeGeometry args={[0.15, 0.15]} />
        <meshBasicMaterial color="#ffffff" side={THREE.DoubleSide} transparent />
      </mesh>
      <mesh position-y={handleY} onPointerDown={startDrag} onPointerOver={hover('grab')} onPointerOut={hover('')}>
        <planeGeometry args={[0.45, 0.35]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {introDone && (
        <Html position={[0.16, handleY, 0]} className="handle-time" zIndexRange={[1, 0]}>
          {clock(frame, tubes.video.fps)}
        </Html>
      )}
      <PlaneSlice tubes={tubes} space={space} frame={frame} />
    </group>
  )
}
