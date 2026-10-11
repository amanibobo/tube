import { Canvas, useFrame, useLoader, useThree, type ThreeEvent } from '@react-three/fiber'
import { Component, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  NoColorSpace,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  ShaderMaterial,
  TextureLoader,
  Vector2,
  Vector3,
  Vector4,
  type Camera,
  type Texture,
} from 'three'
import type { FilmId, Hover, Moment, Search } from './api'
import { atlasUv, framePosition, pageOf, stripOf, type LibraryLayout, type PageLayout, type StripLayout } from './layout'
import { cardMaterial, dimUniform, dotMaterial, fadeUniform, markMaterial, planeMaterial, rawCardsUniform } from './shader'

/** A frame under the pointer; rank is set when the pointer is on a result's lifted card. */
/** Pointer travel (px) past which a press is a camera drag, not a click. */
const DRAG_PX = 4

export interface FrameHit { filmId: FilmId; frame: number; rank: number | null }
export interface ScreenBox { left: number; top: number; right: number; bottom: number }
/** Receives, every frame, the screen box of what the hover card describes (null when it is off-screen). */
export type AnchorSink = (box: ScreenBox | null) => void

export const CARD_COUNT = 12

/** Ease the camera to a film's strip, e.g. one that just finished processing. `at` makes each request distinct. */
export interface FilmFocus { filmId: FilmId; at: number }

interface SceneProps {
  layout: LibraryLayout
  search: Search
  hover: Hover
  /** The result picked with the arrow keys; the camera only moves to it when it is off-screen. */
  stepped: Moment | null
  focus: FilmFocus | null
  onHover: (hit: FrameHit | null) => void
  /** A click (not a drag) on a strip cell or a lifted card. */
  onPick: (hit: FrameHit) => void
  /** A click on empty canvas. */
  onMiss: () => void
  /** Called per atlas page URL once its slices are on the plane, or once its texture failed every retry. */
  onPageSettled: (url: string) => void
  anchorSink: RefObject<AnchorSink | null>
}

export const Scene = memo(function Scene({ layout, search, hover, stepped, focus, onHover, onPick, onMiss, onPageSettled, anchorSink }: SceneProps) {
  const moments = search.status === 'ready' ? search.moments : null
  const heat = search.status === 'ready' ? search.heat : null
  const cards = useRef(new Map<number, Mesh>())
  return (
    <Canvas flat gl={{ alpha: true, antialias: true }} camera={{ fov: FOV, near: 0.05, far: 2000 }} onPointerMissed={onMiss}>
      <CameraRig layout={layout} stepped={stepped} focus={focus} cards={cards} />
      <Dimmer status={search.status} />
      <OwnerMarks layout={layout} />
      {layout.strips.flatMap((strip) => strip.pages.map((page) => (
        <LoadBoundary key={page.url} retry={{ clear: () => useLoader.clear(TextureLoader, [page.url]), giveUp: () => onPageSettled(page.url) }}>
          <Suspense fallback={null}>
            <PageMesh strip={strip} page={page} heat={heat?.get(strip.film.id) ?? null} onHover={onHover} onPick={onPick} onLoaded={onPageSettled} />
          </Suspense>
        </LoadBoundary>
      )))}
      {moments && (
        <LoadBoundary resetOn={moments}>
          <Suspense fallback={null}>
            <Cards layout={layout} moments={moments} onHover={onHover} onPick={onPick} cards={cards} />
          </Suspense>
        </LoadBoundary>
      )}
      <HoverAnchor layout={layout} hover={hover} cards={cards} sink={anchorSink} />
    </Canvas>
  )
})

const LOAD_RETRIES = 3

interface LoadBoundaryProps { resetOn?: unknown; retry?: { clear: () => void; giveUp: () => void }; children: ReactNode }

/**
 * Keeps a failed atlas load from unmounting the whole app: renders nothing for the failed subtree, and with `retry`
 * clears the cached error and remounts it with backoff (1, 2, 4 s) before giving up. A new `resetOn` starts over.
 */
class LoadBoundary extends Component<LoadBoundaryProps, { failed: boolean; failures: number }> {
  state = { failed: false, failures: 0 }
  private timer: ReturnType<typeof setTimeout> | undefined

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch() {
    const { retry } = this.props
    const n = this.state.failures
    if (!retry) return
    if (n >= LOAD_RETRIES) { retry.giveUp(); return }
    this.timer = setTimeout(() => { retry.clear(); this.setState({ failed: false, failures: n + 1 }) }, 1000 * 2 ** n)
  }

  componentDidUpdate(prev: LoadBoundaryProps) {
    if (prev.resetOn !== this.props.resetOn && this.state.failed) this.setState({ failed: false, failures: 0 })
  }

  componentWillUnmount() { clearTimeout(this.timer) }

  render() { return this.state.failed ? null : this.props.children }
}

function useAtlas(urls: string[]): Texture[] {
  const loaded = useLoader(TextureLoader, urls)
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy())
  for (const t of loaded) {
    t.colorSpace = NoColorSpace
    t.anisotropy = maxAnisotropy
  }
  return loaded
}

const imageSize = (t: Texture) => t.image as { width: number; height: number }

const DIM_RATE = 5

function Dimmer({ status }: { status: Search['status'] }) {
  const target = useRef(0)
  useEffect(() => {
    // A search in flight keeps the current dim so a refined query does not flash the archive back up.
    if (status === 'ready') target.current = 1
    else if (status !== 'loading') target.current = 0
  }, [status])
  useFrame((_, dt) => {
    const d = target.current - dimUniform.value
    dimUniform.value = Math.abs(d) < 1e-3 ? target.current : dimUniform.value + d * (1 - Math.exp(-dt * DIM_RATE))
  })
  return null
}

interface PageMeshProps {
  strip: StripLayout
  page: PageLayout
  heat: Uint8Array | null
  onHover: (hit: FrameHit | null) => void
  onPick: (hit: FrameHit) => void
  onLoaded: (url: string) => void
}

const PageMesh = memo(function PageMesh({ strip, page, heat, onHover, onPick, onLoaded }: PageMeshProps) {
  const { film, slice } = strip
  const texture = useAtlas([page.url])[0]!
  const meshRef = useRef<InstancedMesh>(null)

  const { geometry, material, attrs } = useMemo(() => {
    const image = imageSize(texture)
    const uv = new Float32Array(page.count * 2)
    let cell = { du: 0, dv: 0 }
    for (let k = 0; k < page.count; k++) {
      const c = atlasUv(film, page.first + k, image)
      uv[k * 2] = c.u
      uv[k * 2 + 1] = c.v
      cell = c
    }
    const geometry = new PlaneGeometry(slice.w, slice.h)
    const attrs = {
      uv: new InstancedBufferAttribute(uv, 2),
      heat: new InstancedBufferAttribute(new Float32Array(page.count), 1),
    }
    geometry.setAttribute('aUv', attrs.uv)
    geometry.setAttribute('aHeat', attrs.heat)
    return { geometry, material: planeMaterial(texture, new Vector2(cell.du, cell.dv), slice.band), attrs }
  }, [texture, film, page, slice])

  useEffect(() => () => { geometry.dispose(); material.dispose() }, [geometry, material])
  useEffect(() => onLoaded(page.url), [onLoaded, page.url])

  useLayoutEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    const o = new Object3D()
    for (let k = 0; k < page.count; k++) {
      const [x, y] = framePosition(strip, page.first + k)
      o.position.set(x, y, 0)
      o.updateMatrix()
      mesh.setMatrixAt(k, o.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [strip, page, geometry])

  useEffect(() => {
    const a = attrs.heat.array as Float32Array
    for (let k = 0; k < page.count; k++) a[k] = heat ? (heat[page.first + k] ?? 0) / 255 : 0
    attrs.heat.needsUpdate = true
  }, [heat, attrs, page])

  const hit = (e: ThreeEvent<PointerEvent>) => {
    if (e.instanceId === undefined) return
    e.stopPropagation()
    onHover({ filmId: film.id, frame: page.first + e.instanceId, rank: null })
  }
  const pick = (e: ThreeEvent<MouseEvent>) => {
    if (e.instanceId === undefined || e.delta > DRAG_PX) return
    e.stopPropagation()
    onPick({ filmId: film.id, frame: page.first + e.instanceId, rank: null })
  }

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, page.count]}
      frustumCulled={false}
      onPointerMove={hit}
      onPointerOut={() => onHover(null)}
      onClick={pick}
    />
  )
})

/** Gap between a film's near edge (y = 0) and its ownership mark, and the mark's depth, in plane units. */
const MARK_GAP = 0.18
const MARK_DEPTH = 0.12

/** The viewer's own (private) films get a lilac bar under their near end, so they read apart from the public archive. */
function OwnerMarks({ layout }: { layout: LibraryLayout }) {
  const owned = layout.strips.filter((s) => s.film.ownerIsYou)
  const parts = useMemo(() => ({ quad: new PlaneGeometry(1, 1), material: markMaterial() }), [])
  useEffect(() => () => { parts.quad.dispose(); parts.material.dispose() }, [parts])
  return owned.map((strip) => {
    const { x, w } = markSpan(strip)
    return <mesh key={strip.film.id} geometry={parts.quad} material={parts.material} position={[x, -MARK_GAP - MARK_DEPTH / 2, 0]} scale={[w, MARK_DEPTH, 1]} />
  })
}

function markSpan(strip: StripLayout): { x: number; w: number } {
  const first = strip.columns[0]!, last = strip.columns.at(-1)!
  return { x: (first.x + last.x) / 2, w: last.x - first.x + strip.slice.w }
}

const LIFT = 1.1
const RISE_S = 0.7
const STAGGER_S = 0.05
const DOTS = 9
const DOT_PX = 2.6
const RING_PX = 10

interface CardSpec { moment: Moment; strip: StripLayout; base: Vector3; url: string }

function dotCloud(count: number) {
  const geometry = new BufferGeometry()
  const position = new BufferAttribute(new Float32Array(count * 3), 3)
  const alpha = new BufferAttribute(new Float32Array(count), 1)
  geometry.setAttribute('position', position)
  geometry.setAttribute('aAlpha', alpha)
  return { geometry, position, alpha }
}

function Cards({ layout, moments, onHover, onPick, cards }: { layout: LibraryLayout; moments: Moment[]; onHover: (hit: FrameHit | null) => void; onPick: (hit: FrameHit) => void; cards: RefObject<Map<number, Mesh>> }) {
  const specs = useMemo(() => moments.slice(0, CARD_COUNT).flatMap((moment): CardSpec[] => {
    const strip = stripOf(layout, moment.filmId)
    const page = strip && pageOf(strip, moment.frame)
    if (!strip || !page) return []
    const [x, y] = framePosition(strip, moment.frame)
    return [{ moment, strip, base: new Vector3(x, y, 0), url: page.url }]
  }), [layout, moments])
  const urls = useMemo(() => [...new Set(specs.map((s) => s.url))], [specs])
  const textures = useAtlas(urls)
  const dpr = useThree((s) => s.viewport.dpr)

  const materials = useMemo(() => specs.map((s) => {
    const texture = textures[urls.indexOf(s.url)]!
    const image = imageSize(texture)
    const { u, v, du, dv } = atlasUv(s.strip.film, s.moment.frame, image)
    return cardMaterial(texture, new Vector4(u, v, du, dv), new Vector2(1 / image.width, 1 / image.height))
  }), [specs, textures, urls])
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials])

  const parts = useMemo(() => ({
    quad: new PlaneGeometry(1, 1),
    dots: dotCloud(CARD_COUNT * DOTS),
    rings: dotCloud(CARD_COUNT),
    dotMaterial: dotMaterial(DOT_PX * dpr, false),
    ringMaterial: dotMaterial(RING_PX * dpr, true),
  }), [dpr])
  useEffect(() => () => {
    parts.quad.dispose(); parts.dots.geometry.dispose(); parts.rings.geometry.dispose()
    parts.dotMaterial.dispose(); parts.ringMaterial.dispose()
  }, [parts])

  const meshes = useRef<(Mesh | null)[]>([])
  const born = useRef<number | null>(null)
  useEffect(() => { born.current = null }, [specs])
  const scratch = useMemo(() => ({ up: new Vector3(), bottom: new Vector3(), dot: new Vector3() }), [])

  useFrame(({ clock, camera }) => {
    born.current ??= clock.elapsedTime
    const t = clock.elapsedTime - born.current
    const { up, bottom, dot } = scratch
    up.set(0, 1, 0).applyQuaternion(camera.quaternion)
    const { dots, rings } = parts
    dots.alpha.array.fill(0)
    rings.alpha.array.fill(0)
    specs.forEach((s, i) => {
      const mesh = meshes.current[i]
      if (!mesh) return
      const p = Math.min(1, Math.max(0, (t - i * STAGGER_S) / RISE_S))
      const lift = 1 - (1 - p) ** 3
      const scale = 0.25 + 0.75 * lift
      bottom.copy(s.base).setZ(LIFT * lift)
      mesh.position.copy(bottom).addScaledVector(up, (s.strip.card.h * scale) / 2)
      mesh.quaternion.copy(camera.quaternion)
      mesh.scale.set(s.strip.card.w * scale, s.strip.card.h * scale, 1)
      mesh.visible = lift > 0
      ;(mesh.material as ShaderMaterial).uniforms.uOpacity!.value = lift
      for (let d = 0; d < DOTS; d++) {
        dot.lerpVectors(s.base, bottom, (d + 1) / (DOTS + 1))
        dots.position.setXYZ(i * DOTS + d, dot.x, dot.y, dot.z)
        dots.alpha.setX(i * DOTS + d, lift * 0.9)
      }
      rings.position.setXYZ(i, s.base.x, s.base.y, 0.01)
      rings.alpha.setX(i, lift)
    })
    for (const a of [dots.position, dots.alpha, rings.position, rings.alpha]) a.needsUpdate = true
  })

  return (
    <>
      {specs.map((s, i) => (
        <mesh
          key={s.moment.rank}
          ref={(m) => {
            meshes.current[i] = m
            if (m) cards.current.set(s.moment.rank, m)
            else cards.current.delete(s.moment.rank)
          }}
          geometry={parts.quad}
          material={materials[i]}
          visible={false}
          onPointerMove={(e) => { e.stopPropagation(); onHover({ filmId: s.moment.filmId, frame: s.moment.frame, rank: s.moment.rank }) }}
          onPointerOut={() => onHover(null)}
          onClick={(e) => {
            if (e.delta > DRAG_PX) return
            e.stopPropagation()
            onPick({ filmId: s.moment.filmId, frame: s.moment.frame, rank: s.moment.rank })
          }}
        />
      ))}
      <points geometry={parts.dots.geometry} material={parts.dotMaterial} frustumCulled={false} />
      <points geometry={parts.rings.geometry} material={parts.ringMaterial} frustumCulled={false} />
    </>
  )
}

const CARD_CORNERS = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]] as const

/** World corners of what the hover card describes: a result's lifted card, else the frame's slice on the plane. */
function anchorCorners(layout: LibraryLayout, hover: Extract<Hover, { kind: 'frame' }>, cards: Map<number, Mesh>): Vector3[] | null {
  const card = hover.moment ? cards.get(hover.moment.rank) : undefined
  if (card?.visible) {
    card.updateMatrixWorld()
    return CARD_CORNERS.map(([u, v]) => new Vector3(u, v, 0).applyMatrix4(card.matrixWorld))
  }
  const strip = stripOf(layout, hover.filmId)
  if (!strip) return null
  const [x, y] = framePosition(strip, hover.frame)
  const { w, h } = strip.slice
  return CARD_CORNERS.map(([u, v]) => new Vector3(x + u * w, y + v * h, 0))
}

function screenBox(corners: Vector3[], camera: Camera, size: { width: number; height: number; left: number; top: number }): ScreenBox | null {
  const ps = corners.map((c) => c.clone().project(camera))
  if (ps.some((p) => p.z > 1)) return null
  const xs = ps.map((p) => size.left + ((p.x + 1) / 2) * size.width)
  const ys = ps.map((p) => size.top + ((1 - p.y) / 2) * size.height)
  const box = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
  const onScreen = box.right > size.left && box.left < size.left + size.width && box.bottom > size.top && box.top < size.top + size.height
  return onScreen ? box : null
}

function HoverAnchor({ layout, hover, cards, sink }: { layout: LibraryLayout; hover: Hover; cards: RefObject<Map<number, Mesh>>; sink: RefObject<AnchorSink | null> }) {
  useFrame(({ camera, size }) => {
    const place = sink.current
    if (!place || hover.kind === 'none') return
    const corners = anchorCorners(layout, hover, cards.current)
    place(corners && screenBox(corners, camera, size))
  })
  return null
}

const EASE_RATE = 4
/** A focused film is framed at this fraction of the overview's distance. */
const FOCUS_ZOOM = 0.35
const PITCH = (50 * Math.PI) / 180
const FOV = 34
const TAN_HALF_FOV = Math.tan((FOV * Math.PI) / 360)
const MIN_DIST = 1.2
/** Where the overview puts the plane, in NDC: clear of the search pill below, matching the reference framing. */
const FRAME = { x: 0.93, top: 0.66, bottom: -0.62 }

// x, y: the point on the strip plane at screen centre; dist: camera distance from it.
interface View { x: number; y: number; dist: number }

function placeCamera(camera: PerspectiveCamera, v: View, rise = 0) {
  const d = v.dist + rise
  camera.position.set(v.x, v.y - d * Math.sin(PITCH), d * Math.cos(PITCH))
  camera.lookAt(v.x, v.y, 0)
  camera.updateMatrixWorld()
}

/** Camera view that shows the whole plane inside FRAME. */
function fitOverview({ width, length }: LibraryLayout, aspect: number): View {
  const cam = new PerspectiveCamera(FOV, aspect, 0.01, 1e6)
  const corners = [new Vector3(0, 0, 0), new Vector3(width, 0, 0), new Vector3(0, length, 0), new Vector3(width, length, 0)]
  const bounds = (v: View) => {
    placeCamera(cam, v)
    const ps = corners.map((c) => c.clone().project(cam))
    return {
      behind: ps.some((p) => p.z > 1),
      x: Math.max(...ps.map((p) => Math.abs(p.x))),
      top: Math.max(...ps.map((p) => p.y)),
      bottom: Math.min(...ps.map((p) => p.y)),
    }
  }
  const view = { x: width / 2, y: length / 2, dist: 1 }
  for (let pass = 0; pass < 6; pass++) {
    let lo = 0.1, hi = 1e5
    for (let i = 0; i < 48; i++) {
      const mid = Math.sqrt(lo * hi)
      const b = bounds({ ...view, dist: mid })
      if (!b.behind && b.x <= FRAME.x && b.top <= FRAME.top && b.bottom >= FRAME.bottom) hi = mid
      else lo = mid
    }
    view.dist = hi
    const b = bounds(view)
    view.y += (((b.top + b.bottom) / 2 - (FRAME.top + FRAME.bottom) / 2) / (b.top - b.bottom)) * length
  }
  return view
}

function CameraRig({ layout, stepped, focus, cards }: { layout: LibraryLayout; stepped: Moment | null; focus: FilmFocus | null; cards: RefObject<Map<number, Mesh>> }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  const events = useThree((s) => s.events)
  const target = useRef<View | null>(null)
  const current = useRef<View>({ x: 0, y: 0, dist: 10 })
  const overview = useRef<View>({ x: 0, y: 0, dist: 10 })
  const fitted = useRef<LibraryLayout | null>(null)

  useEffect(() => {
    if (fitted.current === layout || layout.strips.length === 0) return
    const first = fitted.current === null
    fitted.current = layout
    overview.current = fitOverview(layout, size.width / size.height)
    // The first layout places the camera; later ones (a film added or removed) ease to the new overview from where it is.
    target.current = { ...overview.current }
    if (first) current.current = { ...overview.current }
  }, [layout, size])

  const focused = useRef<FilmFocus | null>(null)
  useEffect(() => {
    if (!focus || focused.current === focus || !target.current) return
    const strip = stripOf(layout, focus.filmId)
    if (!strip) return  // its library refresh hasn't landed yet; this runs again with the new layout
    focused.current = focus
    const { x } = markSpan(strip)
    target.current = { x, y: (strip.perColumn * strip.slice.h) / 2, dist: Math.min(target.current.dist, overview.current.dist * FOCUS_ZOOM) }
  }, [focus, layout])

  useEffect(() => {
    if (!stepped || !target.current) return
    const strip = stripOf(layout, stepped.filmId)
    if (!strip) return
    const [x, y] = framePosition(strip, stepped.frame)
    const q = new Vector3(x, y, 0).project(camera)
    if (q.z <= 1 && Math.abs(q.x) < 0.85 && Math.abs(q.y) < 0.85) return
    target.current = { ...target.current, x, y }
  }, [stepped, layout, camera])

  useEffect(() => {
    const el = gl.domElement
    const clamp = (v: View): View => ({
      x: Math.min(Math.max(v.x, 0), layout.width),
      y: Math.min(Math.max(v.y, 0), layout.length),
      dist: Math.min(Math.max(v.dist, MIN_DIST), overview.current.dist * 1.5),
    })
    // World units per screen pixel at the focus point; y is foreshortened by the tilt.
    const perPx = (v: View) => (2 * v.dist * TAN_HALF_FOV) / el.clientHeight
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const t = target.current
      if (!t) return
      if (e.ctrlKey || e.metaKey) {
        target.current = clamp({ ...t, dist: t.dist * Math.exp(e.deltaY * 0.01) })
      } else {
        target.current = clamp({ ...t, x: t.x + e.deltaX * perPx(t), y: t.y + (e.deltaY * perPx(t)) / Math.cos(PITCH) })
      }
    }
    let drag: { px: number; py: number } | null = null
    const onDown = (e: PointerEvent) => {
      drag = { px: e.clientX, py: e.clientY }
      el.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      const t = target.current
      if (!drag || !t) return
      const k = perPx(t)
      const next = clamp({ ...t, x: t.x - (e.clientX - drag.px) * k, y: t.y + ((e.clientY - drag.py) * k) / Math.cos(PITCH) })
      target.current = next
      current.current = { ...current.current, x: next.x, y: next.y }
      drag = { px: e.clientX, py: e.clientY }
    }
    const onUp = () => { drag = null }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
  }, [gl, layout])

  // Dev-only handles that scripts/verify.mjs drives: camera placement and where frames and cards land on screen.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const screen = (p: Vector3) => {
      const q = p.clone().project(camera)
      const r = gl.domElement.getBoundingClientRect()
      return { x: r.left + ((q.x + 1) / 2) * r.width, y: r.top + ((1 - q.y) / 2) * r.height }
    }
    const grid = (cols: number, rows: number, inset: number, at: (u: number, v: number) => Vector3) => {
      const points = []
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          points.push(screen(at(inset + ((1 - 2 * inset) * (i + 0.5)) / cols, inset + ((1 - 2 * inset) * (j + 0.5)) / rows)))
        }
      }
      return points
    }
    const slice = (filmId: FilmId, frame: number) => {
      const strip = stripOf(layout, filmId)
      return strip && { strip, at: framePosition(strip, frame) }
    }
    const w = window as unknown as { __vidsearch?: unknown }
    w.__vidsearch = {
      focusFrame(filmId: FilmId, frame: number, zoom?: number) {
        const s = slice(filmId, frame)
        if (!s || !target.current) return
        target.current = { x: s.at[0], y: s.at[1], dist: zoom ? size.height / (2 * zoom * TAN_HALF_FOV) : target.current.dist }
      },
      showOverview() { target.current = { ...overview.current } },
      settled() {
        const t = target.current, c = current.current
        return !!t && t.x === c.x && t.y === c.y && t.dist === c.dist
      },
      view: () => ({ ...current.current, zoom: size.height / (2 * current.current.dist * TAN_HALF_FOV) }),
      screenOf(filmId: FilmId, frame: number) {
        const s = slice(filmId, frame)
        return s ? screen(new Vector3(s.at[0], s.at[1], 0)) : null
      },
      sliceGrid(filmId: FilmId, frame: number, cols: number, rows: number, inset: number) {
        const s = slice(filmId, frame)
        if (!s) return null
        const { w: sw, h: sh, band } = s.strip.slice
        return { band, points: grid(cols, rows, inset, (u, v) => new Vector3(s.at[0] - sw / 2 + u * sw, s.at[1] + sh / 2 - v * sh, 0)) }
      },
      card(rank: number) {
        const m = cards.current.get(rank)
        if (!m?.visible) return null
        m.updateMatrixWorld()
        const corners = CARD_CORNERS.map(([u, v]) => new Vector3(u, v, 0).applyMatrix4(m.matrixWorld))
        return {
          opacity: (m.material as ShaderMaterial).uniforms.uOpacity!.value as number,
          center: screen(new Vector3(0, 0, 0).applyMatrix4(m.matrixWorld)),
          box: screenBox(corners, camera, size),
        }
      },
      cardGrid(rank: number, cols: number, rows: number, inset: number) {
        const m = cards.current.get(rank)
        if (!m) return null
        m.updateMatrixWorld()
        return grid(cols, rows, inset, (u, v) => new Vector3(u - 0.5, 0.5 - v, 0).applyMatrix4(m.matrixWorld))
      },
      rawCards(on: boolean) { rawCardsUniform.value = on ? 1 : 0 },
      /** Screen box of a film's ownership mark, or null when the film has none. */
      ownerMark(filmId: FilmId) {
        const strip = stripOf(layout, filmId)
        if (!strip?.film.ownerIsYou) return null
        const { x, w } = markSpan(strip)
        const y = -MARK_GAP - MARK_DEPTH / 2
        return screenBox(CARD_CORNERS.map(([u, v]) => new Vector3(x + u * w, y + v * MARK_DEPTH, 0)), camera, size)
      },
    }
  }, [layout, camera, gl, size, cards])

  useFrame((_, dt) => {
    const t = target.current
    if (!t) return
    const c = current.current
    const k = 1 - Math.exp(-dt * EASE_RATE)
    c.x += (t.x - c.x) * k
    c.y += (t.y - c.y) * k
    c.dist += (t.dist - c.dist) * k
    const remaining = Math.hypot(t.x - c.x, t.y - c.y)
    if (remaining < 1e-4) { c.x = t.x; c.y = t.y }
    if (Math.abs(t.dist - c.dist) < 1e-4) c.dist = t.dist
    // Rise while travelling so long jumps between results read as a flight over the strips, not a smear.
    const rise = Math.min(remaining * 0.06, 30)
    const before = camera.position.clone()
    placeCamera(camera, c, rise)
    if (before.equals(camera.position)) return
    const d = c.dist + rise
    fadeUniform.value.set(d * 0.95, d * 1.75)
    camera.far = d * 5.2
    camera.updateProjectionMatrix()
    // Re-raycast the last pointer position so the hover card follows what is now under a still cursor.
    events.update?.()
  })

  return null
}
