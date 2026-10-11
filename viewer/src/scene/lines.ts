import * as THREE from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { growClip } from './motion'

type LineOptions = {
  positions: number[]
  colors?: number[]
  color?: THREE.ColorRepresentation
  width: number
  opacity?: number
  additive?: boolean
  clip?: boolean
  renderOrder?: number
}

export function makeLines(o: LineOptions): LineSegments2 {
  const geometry = new LineSegmentsGeometry().setPositions(o.positions)
  if (o.colors) geometry.setColors(o.colors)
  const material = new LineMaterial({
    color: o.colors ? 0xffffff : o.color,
    vertexColors: Boolean(o.colors),
    linewidth: o.width,
    transparent: true,
    opacity: o.opacity ?? 1,
    depthWrite: false,
    blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    clippingPlanes: o.clip === false ? null : [growClip],
  })
  const line = new LineSegments2(geometry, material)
  line.raycast = () => {}
  line.renderOrder = o.renderOrder ?? 1
  line.frustumCulled = false
  return line
}

export function disposeLines(line: LineSegments2) {
  line.geometry.dispose()
  line.material.dispose()
}
