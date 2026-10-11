import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import type { Tubes } from '../types'
import { approach, FADE_TAU, introPhase } from './motion'
import { DEPTH, type Space } from './space'
import { hasThumb, nearestThumb, onThumbs, volumeFrames } from './thumbs'
import { useHighlight } from './useHighlight'

export const VOLUME_SLICES = 96
const W = 192
const H = 108
const IDLE_STRENGTH = 1
const SEARCH_STRENGTH = 0.3
const toLocal = new THREE.Matrix4()

const vertexShader = `
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`

const fragmentShader = `
  precision highp sampler3D;
  uniform sampler3D volume;
  uniform vec3 camLocal;
  uniform vec3 halfSize;
  uniform float depth;
  uniform float planeZ;
  uniform float density;
  uniform float strength;
  varying vec3 vPos;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    vec3 dir = normalize(vPos - camLocal);
    vec3 boxMin = vec3(-halfSize.xy, -depth);
    vec3 boxMax = vec3(halfSize.xy, 0.0);
    vec3 t0 = (boxMin - camLocal) / dir;
    vec3 t1 = (boxMax - camLocal) / dir;
    vec3 tNear = min(t0, t1);
    vec3 tFar = max(t0, t1);
    float enter = max(max(max(tNear.x, tNear.y), tNear.z), 0.0);
    float exit = min(min(tFar.x, tFar.y), tFar.z);
    float tc = (planeZ - camLocal.z) / dir.z;
    vec3 q = camLocal + dir * tc;
    if (tc > 0.0 && abs(q.x) <= halfSize.x && abs(q.y) <= halfSize.y) exit = min(exit, tc);
    if (exit <= enter || strength <= 0.0) discard;

    const int STEPS = 64;
    float stepLen = (exit - enter) / float(STEPS);
    float t = enter + stepLen * hash(gl_FragCoord.xy);
    float a = 1.0 - exp(-density * stepLen);
    vec3 color = vec3(0.0);
    float alpha = 0.0;
    for (int i = 0; i < STEPS; i++) {
      vec3 p = camLocal + dir * t;
      vec3 uvw = vec3(p.x / (2.0 * halfSize.x) + 0.5, p.y / (2.0 * halfSize.y) + 0.5, -p.z / depth);
      vec3 rgb = texture(volume, uvw).rgb;
      float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
      color += (1.0 - alpha) * a * mix(vec3(luma), rgb, 0.3);
      alpha += (1.0 - alpha) * a;
      if (alpha > 0.98) break;
      t += stepLen;
    }
    gl_FragColor = vec4(color * 0.8, alpha) * strength;
  }`

function drawSlice(bitmap: ImageBitmap, ctx: OffscreenCanvasRenderingContext2D, out: Uint8Array, offset: number) {
  ctx.drawImage(bitmap, 0, 0, W, H)
  out.set(ctx.getImageData(0, 0, W, H).data, offset)
}

export function VideoVolume({ tubes, space }: { tubes: Tubes; space: Space }) {
  const video = tubes.video
  const mesh = useRef<THREE.Mesh>(null)
  const frames = useMemo(() => volumeFrames(video, VOLUME_SLICES), [video])
  const { matched } = useHighlight(tubes)
  const strength = useRef(0)

  const { texture, material, geometry } = useMemo(() => {
    const texture = new THREE.Data3DTexture(new Uint8Array(W * H * VOLUME_SLICES * 4), W, H, VOLUME_SLICES)
    texture.format = THREE.RGBAFormat
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.unpackAlignment = 1
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        volume: { value: texture },
        camLocal: { value: new THREE.Vector3() },
        halfSize: { value: new THREE.Vector3(space.imageWidth / 2, space.imageHeight / 2, 0) },
        depth: { value: DEPTH },
        planeZ: { value: -1e6 },
        density: { value: 1.6 },
        strength: { value: 0 },
      },
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.BackSide,
    })
    const geometry = new THREE.BoxGeometry(space.imageWidth, space.imageHeight, DEPTH)
    geometry.translate(0, 0, -DEPTH / 2)
    return { texture, material, geometry }
  }, [space])

  useEffect(() => {
    const ctx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!
    const filled = new Set<number>()
    const fill = () => {
      if (filled.size === frames.length) return
      frames.forEach((f, i) => {
        if (filled.has(i) || !hasThumb(f)) return
        drawSlice(nearestThumb(f)!.bitmap, ctx, texture.image.data as Uint8Array, i * W * H * 4)
        filled.add(i)
      })
      if (filled.size === frames.length) texture.needsUpdate = true
    }
    fill()
    const off = onThumbs(fill)
    return () => {
      off()
      texture.dispose()
      material.dispose()
      geometry.dispose()
    }
  }, [frames, texture, material, geometry])

  useFrame(({ camera }, dt) => {
    const m = mesh.current
    if (!m) return
    const phase = introPhase(performance.now())
    strength.current = approach(strength.current, matched ? SEARCH_STRENGTH : IDLE_STRENGTH, dt, FADE_TAU)
    material.uniforms.camLocal!.value.copy(camera.position).applyMatrix4(toLocal.copy(m.matrixWorld).invert())
    material.uniforms.planeZ!.value = phase.fly < 1 ? -1e6 : space.z(useStore.getState().frame)
    material.uniforms.strength!.value = strength.current * phase.fade
  })

  return <mesh ref={mesh} geometry={geometry} material={material} renderOrder={-1} raycast={() => null} />
}
