import { useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { freeRect, type FreeRect } from '../layout'
import { useStore } from '../store'
import { approach, clamp01, easeInOutCubic, jump, JUMP_MS } from './motion'
import { cubeMatrix, type Space } from './space'

const VIEW_DIR = new THREE.Vector3(-0.12, 0.3, 1).normalize()
const FILL_X = 0.94
const FILL_Y = 0.9
const KEEP_IN_VIEW = 0.7

function measure(camera: THREE.PerspectiveCamera, corners: THREE.Vector3[], distance: number) {
  camera.position.copy(VIEW_DIR).multiplyScalar(distance)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const ndc = corners.map((c) => c.clone().project(camera))
  const xs = ndc.map((p) => p.x)
  const ys = ndc.map((p) => p.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

function shiftToKeep(camera: THREE.Camera, point: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
  const toward = point.clone().sub(target)
  const visible = (t: number) => {
    const p = point.clone().sub(toward.clone().multiplyScalar(t)).project(camera)
    return Math.abs(p.x) <= KEEP_IN_VIEW && Math.abs(p.y) <= KEEP_IN_VIEW && p.z < 1
  }
  if (visible(0)) return new THREE.Vector3()
  let [lo, hi] = [0, 1]
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2
    if (visible(mid)) hi = mid
    else lo = mid
  }
  return toward.multiplyScalar(hi)
}

type Fit = { distance: number; cx: number; cy: number; sx: number; sy: number }

function fitFor(camera: THREE.PerspectiveCamera, corners: THREE.Vector3[], rect: FreeRect, width: number, height: number): Fit {
  const maxX = (FILL_X * 2 * (rect.right - rect.left)) / width
  const maxY = (FILL_Y * 2 * (rect.bottom - rect.top)) / height
  const fits = (d: number) => {
    const m = measure(camera, corners, d)
    return m.maxX - m.minX <= maxX && m.maxY - m.minY <= maxY
  }
  let [lo, hi] = [1, 200]
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) hi = mid
    else lo = mid
  }
  const m = measure(camera, corners, hi)
  return {
    distance: hi,
    cx: (m.minX + m.maxX) / 2,
    cy: (m.minY + m.maxY) / 2,
    sx: (rect.left + rect.right) / width - 1,
    sy: 1 - (rect.top + rect.bottom) / height,
  }
}

export function CameraRig({ space }: { space: Space }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  const controls = useThree((s) => s.controls) as OrbitControls | null
  const empty: Fit = { distance: 1, cx: 0, cy: 0, sx: 0, sy: 0 }
  const fits = useRef({ open: empty, closed: empty })
  const eased = useRef({ x: 0, y: 0, distance: 0 })

  useLayoutEffect(() => {
    camera.aspect = size.width / size.height
    camera.clearViewOffset()
    camera.updateProjectionMatrix()
    const corners = space.corners()
    const closed = fitFor(camera, corners, freeRect(size.width, size.height, false), size.width, size.height)
    const open = fitFor(camera, corners, freeRect(size.width, size.height, true), size.width, size.height)
    fits.current = { open, closed }
    const start = useStore.getState().panelOpen ? open : closed
    measure(camera, corners, start.distance)
    eased.current.distance = start.distance
    if (controls) {
      controls.target.set(0, 0, 0)
      controls.minDistance = open.distance * 0.45
      controls.maxDistance = open.distance * 1.5
      const polar = Math.acos(VIEW_DIR.y)
      controls.minPolarAngle = Math.max(0.2, polar - 0.7)
      controls.maxPolarAngle = Math.min(1.5, polar + 0.3)
      const azimuth = Math.atan2(VIEW_DIR.x, VIEW_DIR.z)
      controls.minAzimuthAngle = azimuth - 1.1
      controls.maxAzimuthAngle = azimuth + 1.1
      controls.update()
    }
  }, [size, space, camera, controls])

  useFrame((_, dt) => {
    const { open, closed } = fits.current
    const goal = useStore.getState().panelOpen ? open : closed
    const goalX = (goal.cx - goal.sx) * (size.width / 2)
    const goalY = (goal.sy - goal.cy) * (size.height / 2)
    const e = eased.current
    const nx = approach(e.x, goalX, dt, 0.08)
    const ny = approach(e.y, goalY, dt, 0.08)
    if (nx !== e.x || ny !== e.y || !camera.view) {
      e.x = nx
      e.y = ny
      camera.setViewOffset(size.width, size.height, nx, ny, size.width, size.height)
    }
    const nd = approach(e.distance, goal.distance, dt, 0.08)
    if (nd !== e.distance && controls) {
      camera.position.sub(controls.target).multiplyScalar(nd / e.distance).add(controls.target)
      e.distance = nd
    }
    const store = useStore.getState()
    const now = performance.now()
    if (jump.pending !== null && controls) {
      const to = jump.pending
      jump.pending = null
      const point = new THREE.Vector3(0, 0, space.z(to)).applyMatrix4(cubeMatrix)
      const shift = shiftToKeep(camera, point, controls.target)
      jump.active = {
        from: store.frame,
        to,
        startedAt: now,
        camera: { from: camera.position.clone(), to: camera.position.clone().add(shift) },
        target: { from: controls.target.clone(), to: controls.target.clone().add(shift) },
      }
    }
    const active = jump.active
    if (active && controls) {
      const k = easeInOutCubic(clamp01((now - active.startedAt) / JUMP_MS))
      store.setFrame(active.from + (active.to - active.from) * k, k < 1 ? 'tween' : 'scene')
      if (!active.camera.from.equals(active.camera.to)) {
        camera.position.lerpVectors(active.camera.from, active.camera.to, k)
        controls.target.lerpVectors(active.target.from, active.target.to, k)
      }
      if (k >= 1) jump.active = null
    }
  })

  return null
}
