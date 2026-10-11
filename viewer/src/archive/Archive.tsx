import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { AccountCorner } from './Account'
import { FALLBACK_IDENTITY, fetchLibrary, frameStillUrl, libraryLoaded, libraryRefreshed, momentAt, pageSettled, runSearch, setDeviceId, type Film, type FilmId, type Hover, type Library, type Moment, type Search, type UploadsMode } from './api'
import { useAccount } from './auth'
import { newDeviceId, storedDeviceId } from './device'
import { layoutLibrary } from './layout'
import { clipTitle, clipWindow, CUBE_AVAILABLE, sendToCube } from './cube'
import { Loader, useElapsed } from './Loader'
import { Masthead } from './Masthead'
import { Scene, type AnchorSink, type FilmFocus, type FrameHit, type ScreenBox } from './Scene'
import { useUploads } from './uploads'
import { useVoice, voiceActive, type Ending } from './voice'

/**
 * Who chose the frame the card shows: the pointer, the arrow keys stepping through results, or a click that pins it.
 * A pin outlasts hovering elsewhere and moves with the arrow keys; Esc, its ×, or a click on empty canvas lets go.
 */
type Pick =
  | { by: 'pointer'; hit: FrameHit | null }
  | { by: 'keys'; index: number }
  | { by: 'pin'; hit: FrameHit; expanded: boolean }

const pinOf = (m: Moment): Pick => ({ by: 'pin', hit: { filmId: m.filmId, frame: m.frame, rank: m.rank }, expanded: false })

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
const NO_FILMS: Film[] = []
const NO_MOMENTS: Moment[] = []
const NO_PICK: Pick = { by: 'pointer', hit: null }
const sameHit = (a: FrameHit | null, b: FrameHit | null) =>
  a === b || (!!a && !!b && a.filmId === b.filmId && a.frame === b.frame && a.rank === b.rank)

function hoverOf(pick: Pick, moments: readonly Moment[]): Hover {
  if (pick.by === 'keys') {
    const m = moments[pick.index]
    return m ? { kind: 'frame', filmId: m.filmId, frame: m.frame, moment: m } : { kind: 'none' }
  }
  const { hit } = pick
  if (!hit) return { kind: 'none' }
  const moment = hit.rank === null ? momentAt(moments, hit.filmId, hit.frame) : moments.find((m) => m.rank === hit.rank) ?? null
  return { kind: 'frame', filmId: hit.filmId, frame: hit.frame, moment }
}

export function Archive() {
  const [library, setLibrary] = useState<Library>(() => ({ status: 'waking', since: Date.now() }))
  const [search, setSearch] = useState<Search>({ status: 'idle' })
  const [pick, setPick] = useState<Pick>(NO_PICK)
  const inflight = useRef<AbortController | null>(null)
  const anchorSink = useRef<AnchorSink | null>(null)
  const { session } = useAccount()
  /** From the API with the library; null until it first answers. */
  const [uploadsMode, setUploadsMode] = useState<UploadsMode | null>(null)
  /** This browser's upload identity in `device` mode; null until it first uploads (or opens its uploads). */
  const [device, setDevice] = useState<string | null>(null)
  const viewer = uploadsMode === 'device' ? device : session.status === 'signed-in' ? session.viewer.sub : null
  const [focus, setFocus] = useState<FilmFocus | null>(null)
  const [identity, setIdentity] = useState(FALLBACK_IDENTITY)
  const [voice, setVoice] = useState(false)
  useEffect(() => { document.title = identity.title }, [identity.title])
  /** The viewer the library was last fetched for. */
  const loadedFor = useRef(viewer)

  // The first load waits for sign-in to settle, so a signed-in viewer's own films come with it. In device mode
  // (known only from the answer) a browser that has uploaded before asks again as itself, before anything shows.
  const wakingSince = library.status === 'waking' ? library.since : null
  const authSettled = session.status !== 'checking'
  useEffect(() => {
    if (wakingSince === null || !authSettled) return
    const ctrl = new AbortController()
    const load = async () => {
      const first = await fetchLibrary(ctrl.signal)
      const id = first.uploads === 'device' ? storedDeviceId() : null
      setDeviceId(id)
      const archive = id ? await fetchLibrary(ctrl.signal) : first
      loadedFor.current = archive.uploads === 'device' ? id : viewer
      setUploadsMode(archive.uploads)
      setIdentity(archive.identity)
      setVoice(archive.voice)
      setDevice(id)
      setLibrary(libraryLoaded(archive.films))
    }
    load().catch((e: unknown) => { if (!isAbort(e)) setLibrary({ status: 'error', message: errorMessage(e) }) })
    return () => ctrl.abort()
  }, [wakingSince, authSettled, viewer])

  /** The first upload (or look at my uploads) in device mode mints this browser's id. Nothing to refetch: it owns no films yet. */
  const ensureDevice = useCallback(() => {
    if (device) return
    const id = newDeviceId()
    setDeviceId(id)
    loadedFor.current = id
    setDevice(id)
  }, [device])
  const retryLibrary = useCallback(() => setLibrary({ status: 'waking', since: Date.now() }), [])

  /** Refetch after the visible set changed (sign-in or out, a finished upload, a delete) without the first-load loader. */
  const refreshLibrary = useCallback(async () => {
    const { films } = await fetchLibrary(new AbortController().signal)
    setLibrary((l) => (l.status === 'waking' ? l : libraryRefreshed(l, films)))
  }, [])
  useEffect(() => {
    if (loadedFor.current === viewer) return
    loadedFor.current = viewer
    refreshLibrary().catch(() => {})
  }, [viewer, refreshLibrary])

  const onFilmReady = useCallback((filmId: FilmId) => {
    refreshLibrary().then(() => setFocus({ filmId, at: Date.now() })).catch(() => {})
  }, [refreshLibrary])
  const uploads = useUploads(viewer, onFilmReady)
  const onLibraryChanged = useCallback(() => { refreshLibrary().catch(() => {}) }, [refreshLibrary])
  const showFilm = useCallback((filmId: FilmId) => setFocus({ filmId, at: Date.now() }), [])
  const onPageSettled = useCallback((url: string) => setLibrary((l) => pageSettled(l, url)), [])

  const films = library.status === 'ready' || library.status === 'frames' ? library.films : NO_FILMS
  const layout = useMemo(() => layoutLibrary(films), [films])
  const moments = search.status === 'ready' ? search.moments : NO_MOMENTS
  const hover = useMemo(() => hoverOf(pick, moments), [pick, moments])
  const focusIndex = hover.kind === 'frame' && hover.moment ? moments.indexOf(hover.moment) : -1
  const stepped = pick.by === 'keys' ? moments[pick.index] ?? null : pick.by === 'pin' && hover.kind === 'frame' ? hover.moment : null

  const submit = useCallback((raw: string) => {
    const query = raw.trim()
    inflight.current?.abort()
    setPick(NO_PICK)
    if (!query) {
      inflight.current = null
      setSearch({ status: 'idle' })
      return
    }
    const ctrl = new AbortController()
    inflight.current = ctrl
    setSearch({ status: 'loading', query, since: Date.now() })
    runSearch(query, ctrl.signal)
      .then((ready) => { setPick(NO_PICK); setSearch(ready) })
      .catch((e: unknown) => { if (!isAbort(e)) setSearch({ status: 'error', query, message: errorMessage(e) }) })
  }, [])

  const onHover = useCallback((hit: FrameHit | null) => {
    setPick((p) => (p.by !== 'pointer' || sameHit(p.hit, hit) ? p : { by: 'pointer', hit }))
  }, [])
  const onPin = useCallback((hit: FrameHit) => {
    setPick((p) => (p.by === 'pin' && sameHit(p.hit, hit) ? p : { by: 'pin', hit, expanded: false }))
  }, [])
  const unpin = useCallback(() => setPick((p) => (p.by === 'pin' ? NO_PICK : p)), [])
  const setExpanded = useCallback((expanded: boolean) => setPick((p) => (p.by === 'pin' ? { ...p, expanded } : p)), [])

  const pinned = pick.by === 'pin'
  const step = useCallback((by: number) => {
    const n = moments.length
    if (!n) return
    const index = focusIndex < 0 ? (by > 0 ? 0 : n - 1) : (focusIndex + by + n) % n
    setPick(pinned ? pinOf(moments[index]!) : { by: 'keys', index })
  }, [moments, focusIndex, pinned])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inInput = e.target instanceof HTMLInputElement
      if (e.key === 'ArrowDown' || (e.key === 'ArrowRight' && !inInput)) { e.preventDefault(); step(1) }
      if (e.key === 'ArrowUp' || (e.key === 'ArrowLeft' && !inInput)) { e.preventDefault(); step(-1) }
      // Voice search claims Esc first (and prevents it) while it listens.
      if (e.key === 'Escape' && !e.defaultPrevented) setPick((p) => (p.by !== 'pin' ? p : p.expanded ? { ...p, expanded: false } : NO_PICK))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  // A stepped card stays up until the pointer really moves; camera moves re-raycast a still pointer and must not steal it.
  useEffect(() => {
    let last: { x: number; y: number } | null = null
    const onMove = (e: PointerEvent) => {
      const moved = !last || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 2
      last = { x: e.clientX, y: e.clientY }
      if (moved) setPick((p) => (p.by === 'keys' ? NO_PICK : p))
    }
    window.addEventListener('pointermove', onMove, { capture: true })
    return () => window.removeEventListener('pointermove', onMove, { capture: true })
  }, [])

  const onResult = pick.by === 'pointer' && hover.kind === 'frame' && hover.moment !== null
  const ready = library.status === 'ready'
  return (
    <>
      <div className={['stage', ready && 'shown', onResult && 'on-result'].filter(Boolean).join(' ')}>
        <Scene layout={layout} search={search} hover={hover} stepped={stepped} focus={focus} onHover={onHover} onPick={onPin} onMiss={unpin} onPageSettled={onPageSettled} anchorSink={anchorSink} />
      </div>
      <Masthead identity={identity} films={films.length ? films : null} />
      {ready && uploadsMode && <AccountCorner mode={uploadsMode} noun={identity.noun} uploads={uploads} films={films} onLibraryChanged={onLibraryChanged} onDeviceNeeded={ensureDevice} onShowFilm={showFilm} />}
      <Loader library={library} onRetry={retryLibrary} />
      {hover.kind === 'frame' && (
        <HoverCard
          hover={hover}
          film={films.find((f) => f.id === hover.filmId)}
          sink={anchorSink}
          pin={pick.by === 'pin' ? { expanded: pick.expanded, onExpand: setExpanded, onUnpin: unpin } : null}
        />
      )}
      <SearchPill status={pillStatus(search, focusIndex)} disabled={!ready} voice={voice} onSubmit={submit} />
    </>
  )
}

/** m:ss.s, as the reference labels its cards. */
function clock(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10))
  const s = tenths % 600
  return `${Math.floor(tenths / 600)}:${String(Math.floor(s / 10)).padStart(2, '0')}.${s % 10}`
}

const CONNECTOR_PX = 96
const SIDE_CONNECTOR_PX = 56
const EDGE_PX = 12

type Placement = { card: { left: number; top: number }; line: { x: number; y: number; length: number; vertical: boolean }; ring: { x: number; y: number } }

/** Above the hovered object when it fits (the reference's default), else beside it, else below; never over it. */
function place(box: ScreenBox, w: number, h: number): Placement {
  const vw = window.innerWidth, vh = window.innerHeight
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2
  const clampX = (x: number) => Math.min(Math.max(x, EDGE_PX), vw - w - EDGE_PX)
  // Cards stay above the search pill.
  const floor = (document.querySelector('.pill')?.getBoundingClientRect().top ?? vh) - EDGE_PX
  const clampY = (y: number) => Math.min(Math.max(y, EDGE_PX), floor - h)
  if (box.top - CONNECTOR_PX - h >= EDGE_PX) {
    return { card: { left: clampX(cx - w / 2), top: box.top - CONNECTOR_PX - h }, line: { x: cx, y: box.top - CONNECTOR_PX, length: CONNECTOR_PX, vertical: true }, ring: { x: cx, y: box.top } }
  }
  if (box.right + SIDE_CONNECTOR_PX + w <= vw - EDGE_PX) {
    return { card: { left: box.right + SIDE_CONNECTOR_PX, top: clampY(box.top) }, line: { x: box.right, y: cy, length: SIDE_CONNECTOR_PX, vertical: false }, ring: { x: box.right, y: cy } }
  }
  if (box.left - SIDE_CONNECTOR_PX - w >= EDGE_PX) {
    return { card: { left: box.left - SIDE_CONNECTOR_PX - w, top: clampY(box.top) }, line: { x: box.left - SIDE_CONNECTOR_PX, y: cy, length: SIDE_CONNECTOR_PX, vertical: false }, ring: { x: box.left, y: cy } }
  }
  return { card: { left: clampX(cx - w / 2), top: box.bottom + CONNECTOR_PX }, line: { x: cx, y: box.bottom, length: CONNECTOR_PX, vertical: true }, ring: { x: cx, y: box.bottom } }
}

/** A pinned card's controls: the full caption, and letting go. */
interface PinControls { expanded: boolean; onExpand: (expanded: boolean) => void; onUnpin: () => void }

function HoverCard({ hover, film, sink, pin }: { hover: Extract<Hover, { kind: 'frame' }>; film: Film | undefined; sink: RefObject<AnchorSink | null>; pin: PinControls | null }) {
  const root = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const line = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const time = hover.moment ? hover.moment.start : film ? hover.frame / film.sampleFps : 0
  // The frame still covers the video from each new seek until it can play there, so the card is never an empty box.
  const seekKey = `${film?.id}@${time}`
  const [playingKey, setPlayingKey] = useState<string | null>(null)

  useLayoutEffect(() => {
    let last = ''
    sink.current = (box) => {
      const el = root.current, c = card.current, l = line.current, r = ring.current
      if (!el || !c || !l || !r) return
      if (!box) { el.style.visibility = 'hidden'; last = ''; return }
      const p = place(box, c.offsetWidth, c.offsetHeight)
      const key = JSON.stringify(p)
      if (key === last) return
      last = key
      el.style.visibility = 'visible'
      c.style.transform = `translate(${p.card.left}px, ${p.card.top}px)`
      l.className = p.line.vertical ? 'connector vertical' : 'connector horizontal'
      l.style.transform = `translate(${p.line.x}px, ${p.line.y}px)`
      l.style.width = p.line.vertical ? '0' : `${p.line.length}px`
      l.style.height = p.line.vertical ? `${p.line.length}px` : '0'
      r.style.transform = `translate(${p.ring.x}px, ${p.ring.y}px)`
    }
    return () => { sink.current = null }
  }, [sink])

  useEffect(() => {
    const v = video.current
    if (!v) return
    const playing = () => setPlayingKey(seekKey)
    const seeked = () => {
      if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) playing()
      else v.addEventListener('canplay', playing, { once: true })
    }
    const seek = () => {
      v.addEventListener('seeked', seeked, { once: true })
      v.currentTime = time
      void v.play().catch(() => {})
    }
    if (v.readyState >= HTMLMediaElement.HAVE_METADATA) seek()
    else v.addEventListener('loadedmetadata', seek, { once: true })
    return () => {
      v.removeEventListener('loadedmetadata', seek)
      v.removeEventListener('seeked', seeked)
      v.removeEventListener('canplay', playing)
    }
  }, [time, seekKey])

  if (!film) return null
  return (
    <div className={pin ? 'hover pinned' : 'hover'} ref={root} style={{ visibility: 'hidden' }}>
      <div className="connector" ref={line} />
      <div className="connector-ring" ref={ring} />
      <div className="card" ref={card}>
        <div className="card-media" style={{ aspectRatio: `${film.atlas.cellW} / ${film.atlas.cellH}` }}>
          <video key={film.id} ref={video} src={film.videoUrl} muted playsInline preload="auto" />
          {playingKey !== seekKey && (
            <div className="card-still">
              <img src={frameStillUrl(film.id, hover.frame)} alt="" />
              <span className="spinner" role="status" aria-label="loading video" />
            </div>
          )}
        </div>
        <div className="card-head">
          <div className="card-label">{film.title} · {clock(time)}</div>
          {pin && (
            <span className="card-pin">
              Pinned
              <button type="button" className="card-close" aria-label="Unpin" title="Unpin (Esc)" onClick={pin.onUnpin}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
              </button>
            </span>
          )}
        </div>
        {hover.moment?.caption && <p className={pin?.expanded ? 'card-caption full' : 'card-caption'}>{hover.moment.caption}</p>}
        {pin && (
          <CardActions
            key={`${film.id}@${hover.frame}`}
            film={film}
            t={hover.moment ? hover.moment.t : hover.frame / film.sampleFps}
            caption={!!hover.moment?.caption}
            pin={pin}
          />
        )}
      </div>
    </div>
  )
}

type Sending = { kind: 'idle' } | { kind: 'sending' } | { kind: 'error'; message: string }

function CardActions({ film, t, caption, pin }: { film: Film; t: number; caption: boolean; pin: PinControls }) {
  const [sending, setSending] = useState<Sending>({ kind: 'idle' })
  const clip = clipWindow(t, film.duration)
  const open = () => {
    setSending({ kind: 'sending' })
    void sendToCube(film, clip).then((r) => {
      if (r.ok) location.assign(`/app?v=${encodeURIComponent(r.id)}`)
      else setSending({ kind: 'error', message: r.message })
    })
  }
  return (
    <div className="card-actions">
      <div className="card-buttons">
        {caption && (
          <button type="button" className="text-button" onClick={() => pin.onExpand(!pin.expanded)}>
            {pin.expanded ? 'Less' : 'Expand'}
          </button>
        )}
        <button
          type="button"
          className="text-button card-cube"
          disabled={!CUBE_AVAILABLE || sending.kind === 'sending'}
          title={clipTitle(film, clip)}
          onClick={open}
        >
          {sending.kind === 'sending' ? 'Opening in the cube…' : 'Open in the cube'}
        </button>
        <span className="card-note">±20 s</span>
      </div>
      {!CUBE_AVAILABLE && <p className="card-note">Open in the cube needs Tube running locally</p>}
      {sending.kind === 'error' && <p className="card-error" role="alert">{sending.message}</p>}
    </div>
  )
}

type PillStatus = { kind: 'none' } | { kind: 'busy'; since: number } | { kind: 'error'; message: string } | { kind: 'count'; text: string }

/** A search still running after this long is most likely waiting on a cold API container. */
const WAKING_AFTER_MS = 2000

function pillStatus(search: Search, focusIndex: number): PillStatus {
  if (search.status === 'loading') return { kind: 'busy', since: search.since }
  if (search.status === 'error') return { kind: 'error', message: search.message }
  if (search.status === 'ready') {
    const n = search.moments.length
    return { kind: 'count', text: focusIndex >= 0 ? `${focusIndex + 1}/${n}` : `${n}` }
  }
  return { kind: 'none' }
}

function SearchPill({ status, disabled, voice, onSubmit }: { status: PillStatus; disabled: boolean; voice: boolean; onSubmit: (query: string) => void }) {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const mic = useRef<HTMLButtonElement>(null)
  const busyFor = useElapsed(status.kind === 'busy' ? status.since : null)
  useEffect(() => { if (!disabled) input.current?.focus() }, [disabled])
  const onHeard = useCallback((heard: string, ending: Ending) => {
    const el = input.current
    if (heard) {
      setText(heard)
      if (ending === 'auto') onSubmit(heard)
    }
    // After React writes the value: caret and scroll at the end, so a long query shows its last words.
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); if (el) el.scrollLeft = el.scrollWidth })
  }, [onSubmit])
  const v = useVoice(mic, onHeard)
  const active = voiceActive(v.state)
  const { stop } = v
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); stop() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, stop])
  const heard = v.state.kind === 'listening' || v.state.kind === 'finishing' ? v.state : null
  const hint = v.state.kind === 'requesting' ? 'Allow the microphone…' : v.state.kind === 'connecting' ? 'Connecting…' : 'Listening…'
  return (
    <form className="pill" onSubmit={(e) => { e.preventDefault(); if (active) stop(); else onSubmit(text) }}>
      <svg className="pill-icon" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="6.75" cy="6.75" r="4.75" />
        <path d="M10.4 10.4 14 14" />
      </svg>
      <div className="pill-field">
        <input
          ref={input}
          className={active ? 'hearing' : undefined}
          disabled={disabled}
          value={text}
          onChange={(e) => { v.cancel(); v.dismiss(); setText(e.target.value) }}
          placeholder={disabled ? 'Waiting for the archive…' : 'Search the archive'}
          aria-label="Search"
          spellCheck={false}
        />
        {active && (
          <div className="pill-transcript" aria-live="polite">
            {heard && (heard.committed || heard.partial)
              ? <span>{heard.committed}{heard.committed && heard.partial ? ' ' : ''}<span className="partial">{heard.partial}</span></span>
              : <span className="hint">{hint}</span>}
          </div>
        )}
      </div>
      <span className="pill-status" aria-live="polite">
        {v.state.kind === 'error' && <span className="pill-error" title={v.state.detail}>{v.state.message}</span>}
        {(v.state.kind === 'connecting' || v.state.kind === 'finishing') && <span className="spinner" role="status" aria-label={v.state.kind} />}
        {v.state.kind === 'idle' && <>
          {status.kind === 'busy' && busyFor > WAKING_AFTER_MS && <span className="pill-waking">Waking up…</span>}
          {status.kind === 'busy' && <span className="spinner" role="status" aria-label="searching" />}
          {status.kind === 'error' && <span className="pill-error" title={status.message}>{status.message}</span>}
          {status.kind === 'count' && <span className="pill-count">{status.text}</span>}
        </>}
      </span>
      {text && !active && (
        <button type="button" className="pill-clear" aria-label="Clear search" onClick={() => { setText(''); onSubmit(''); input.current?.focus() }}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      )}
      {voice && (
        <button
          type="button"
          ref={mic}
          className={`pill-mic ${v.state.kind}`}
          disabled={disabled}
          aria-label={active ? 'Stop listening' : 'Search by voice'}
          aria-pressed={active}
          title={active ? 'Stop listening (Esc)' : 'Search by voice'}
          onClick={() => (active ? stop() : v.start())}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="5.5" y="1.75" width="5" height="8" rx="2.5" />
            <path d="M3.25 7.75a4.75 4.75 0 0 0 9.5 0M8 12.5v1.75" />
          </svg>
        </button>
      )}
    </form>
  )
}
