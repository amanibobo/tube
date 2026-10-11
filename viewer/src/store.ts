import { create } from 'zustand'
import { api, STATIC } from './api'
import { chooseTrack, DEFAULT_TRACK_TEXT } from './classes'
import type { Sampling } from './scene/geometry'
import { requestJump, resetMotion } from './scene/motion'
import { samplingFor } from './scene/space'
import { isClassSearch, type Search } from './search'
import type { JobEvent, NearMiss, Track, Trackable, Tubes, VideoId, VideoMeta } from './types'
import { hasTubes, isVideoFile, titleFromFile } from './videos'

export type FrameSource = 'video' | 'scene' | 'tween'

/** A picked file waits in `choosing` while the user says what to track; Start sends it, Cancel drops it. */
export type Upload =
  | { kind: 'idle' }
  | { kind: 'choosing'; file: File; text: string; error: string | null }
  | { kind: 'sending'; name: string; loaded: number; total: number }
  | { kind: 'rejected'; message: string }

type VideoState = {
  meta: VideoMeta | null
  tubes: Tubes | null
  sampling: Sampling | null
  frame: number
  frameSource: FrameSource
  input: string
  search: Search
  focus: NearMiss | null
  nearMisses: NearMiss[]
  scrubbing: boolean
  introDone: boolean
  railShown: boolean
}

type State = VideoState & {
  library: VideoMeta[]
  videoId: VideoId | null
  loadError: string | null
  libraryOpen: boolean
  upload: Upload
  /** What the detector can track, fetched when a file is first picked. */
  trackable: Trackable | null
  notice: { id: VideoId; text: string } | null
  panelOpen: boolean
}

type Actions = {
  start(): Promise<void>
  select(id: VideoId, force?: boolean): void
  toggleLibrary(open?: boolean): void
  pickFile(file: File): void
  editTrack(text: string): void
  startUpload(): Promise<void>
  cancelUpload(): void
  setFrame(f: number, source: FrameSource): void
  jumpTo(f: number): void
  setScrubbing(scrubbing: boolean): void
  finishIntro(): void
  type(text: string): void
  ask(text: string): Promise<void>
  clear(): void
  focusNearMiss(item: NearMiss): void
  togglePanel(): void
}

const freshVideoState = (meta: VideoMeta | null): VideoState => ({
  meta,
  tubes: null,
  sampling: null,
  frame: 0,
  frameSource: 'scene',
  input: '',
  search: { kind: 'idle' },
  focus: null,
  nearMisses: [],
  scrubbing: false,
  introDone: false,
  railShown: false,
})

function mergeTubes(prev: Tubes | null, next: Tubes): Tubes {
  if (!prev) return next
  const sameClip = (['fps', 'width', 'height', 'frames'] as const).every((k) => prev.video[k] === next.video[k])
  const old = new Map(prev.tracks.map((t) => [t.id, t]))
  const same = (a: Track, b: Track) => a.first_frame === b.first_frame && a.last_frame === b.last_frame && a.frames.length === b.frames.length
  const tracks = next.tracks.map((t) => {
    const kept = old.get(t.id)
    return kept && same(kept, t) ? kept : t
  })
  const unchanged = sameClip && tracks.length === prev.tracks.length && tracks.every((t, i) => t === prev.tracks[i])
  return unchanged ? prev : { video: sameClip ? prev.video : next.video, tracks }
}

function readUrlVideo(): VideoId | null {
  return (new URLSearchParams(location.search).get('v') as VideoId | null) ?? null
}

function writeUrlVideo(id: VideoId) {
  const url = new URL(location.href)
  url.searchParams.set('v', id)
  history.replaceState(null, '', url)
}

let closeEvents: () => void = () => {}
let tubesFetch: { id: VideoId; again: boolean } | null = null

export const useStore = create<State & Actions>((set, get) => {
  const current = (id: VideoId) => get().videoId === id

  const patchMeta = (id: VideoId, patch: Partial<VideoMeta>) => {
    const library = get().library.map((m) => (m.id === id ? { ...m, ...patch } : m))
    const meta = get().meta
    set({ library, ...(current(id) && meta ? { meta: { ...meta, ...patch } } : {}) })
  }

  const showMeta = (meta: VideoMeta) => {
    patchMeta(meta.id, meta)
    if (!hasTubes(meta) && current(meta.id)) set({ railShown: true })
  }

  async function fetchTubes(id: VideoId) {
    if (tubesFetch?.id === id) {
      tubesFetch.again = true
      return
    }
    const mine = { id, again: true }
    tubesFetch = mine
    try {
      while (mine.again && current(id)) {
        mine.again = false
        const next = await api.tubes(id)
        if (!next || !current(id)) continue
        const tubes = mergeTubes(get().tubes, next.tubes)
        const sampling = get().sampling ?? (tubes.tracks.length > 0 ? samplingFor(tubes.video, tubes.tracks, next.framesDone) : null)
        if (tubes !== get().tubes || sampling !== get().sampling) set({ tubes, sampling })
      }
    } catch (err) {
      if (current(id) && !get().tubes) set({ loadError: `Could not load the tubes. ${(err as Error).message}.`, railShown: true })
    } finally {
      if (tubesFetch === mine) tubesFetch = null
    }
  }

  async function loadReady(id: VideoId) {
    await fetchTubes(id)
    const nearMisses = await api.nearMisses(id, 10).catch(() => [])
    if (current(id)) set({ nearMisses })
  }

  function onEvent(id: VideoId, event: JobEvent) {
    if (!current(id)) return
    switch (event.type) {
      case 'status': {
        const { status, stage, progress } = event
        patchMeta(id, { status, stage, progress })
        if (hasTubes({ status, stage }) && !get().tubes) void fetchTubes(id)
        return
      }
      case 'tubes':
        return void fetchTubes(id)
      case 'done':
        patchMeta(id, { status: 'ready', stage: null, progress: 1 })
        void loadReady(id)
        void api.video(id).then(showMeta, () => {})
        return
      case 'error':
        patchMeta(id, { status: 'failed', stage: null, error: event.message })
        set({ railShown: true })
        return
    }
  }

  async function open(id: VideoId) {
    try {
      const meta = await api.video(id)
      if (!current(id)) return
      showMeta(meta)
      if (meta.status === 'ready') return void loadReady(id)
      if (meta.status === 'failed') return
      closeEvents = api.events(id, (event) => onEvent(id, event))
      if (hasTubes(meta)) void fetchTubes(id)
    } catch (err) {
      if (current(id)) set({ loadError: `Could not open this video. ${(err as Error).message}.`, railShown: true })
    }
  }

  return {
    ...freshVideoState(null),
    library: [],
    videoId: null,
    loadError: null,
    libraryOpen: false,
    upload: { kind: 'idle' },
    trackable: null,
    notice: null,
    panelOpen: true,

    async start() {
      try {
        const library = await api.videos()
        set({ library })
        const wanted = readUrlVideo()
        const pick = library.find((m) => m.id === wanted) ?? library.find((m) => m.status === 'ready') ?? library[0]
        if (pick) get().select(pick.id)
        else set({ loadError: 'No videos yet. Upload one to begin.', railShown: true })
      } catch (err) {
        set({ loadError: `Could not reach the server. ${(err as Error).message}.`, railShown: true })
      }
    },

    select(id, force = false) {
      if (current(id) && !force) return set({ libraryOpen: false })
      closeEvents()
      closeEvents = () => {}
      resetMotion()
      const { notice, upload } = get()
      set({
        ...freshVideoState(get().library.find((m) => m.id === id) ?? null),
        videoId: id,
        loadError: null,
        libraryOpen: false,
        notice: notice?.id === id ? notice : null,
        upload: upload.kind === 'rejected' ? { kind: 'idle' } : upload,
      })
      writeUrlVideo(id)
      void open(id)
    },

    toggleLibrary(open) {
      const next = open ?? !get().libraryOpen
      set({ libraryOpen: next })
      if (next) void api.videos().then((library) => set({ library }), () => {})
    },

    pickFile(file) {
      if (STATIC) return set({ upload: { kind: 'rejected', message: 'Uploads need Tube running locally.' } })
      if (!isVideoFile(file)) {
        return set({ upload: { kind: 'rejected', message: `${file.name} isn’t a video. Try an MP4 or MOV file.` } })
      }
      api.warm()
      if (!get().trackable) void api.trackable().then((trackable) => set({ trackable }), () => {})
      set({ upload: { kind: 'choosing', file, text: DEFAULT_TRACK_TEXT, error: null }, libraryOpen: false })
    },

    editTrack(text) {
      const upload = get().upload
      if (upload.kind === 'choosing') set({ upload: { ...upload, text, error: null } })
    },

    cancelUpload() {
      if (get().upload.kind === 'choosing') set({ upload: { kind: 'idle' } })
    },

    async startUpload() {
      const choosing = get().upload
      if (choosing.kind !== 'choosing') return
      const { file } = choosing
      const choice = chooseTrack(choosing.text, get().trackable)
      if (!choice.ok) return set({ upload: { ...choosing, error: choice.message } })
      set({ upload: { kind: 'sending', name: file.name, loaded: 0, total: file.size } })
      const result = await api.upload(file, titleFromFile(file.name), choice.track, (loaded, total) =>
        set({ upload: { kind: 'sending', name: file.name, loaded, total } }),
      )
      if (!result.ok) return set({ upload: { ...choosing, error: result.message } })
      const { meta } = result
      set({
        upload: { kind: 'idle' },
        library: [meta, ...get().library.filter((m) => m.id !== meta.id)],
        notice: meta.notice ? { id: meta.id, text: meta.notice } : null,
      })
      get().select(meta.id)
    },

    setFrame(f, source) {
      const tubes = get().tubes
      if (!tubes) return
      const frame = Math.max(0, Math.min(tubes.video.frames - 1, Math.round(f)))
      if (frame !== get().frame || source !== get().frameSource) set({ frame, frameSource: source })
    },

    jumpTo: (f) => requestJump(f),
    setScrubbing: (scrubbing) => set({ scrubbing }),
    finishIntro: () => set({ introDone: true, railShown: true }),

    type(text) {
      set({ input: text })
      if (!text.trim()) return set({ search: { kind: 'idle' }, focus: null })
      if (isClassSearch(text)) set({ search: { kind: 'classes', text }, focus: null })
    },

    async ask(text) {
      if (isClassSearch(text)) return get().type(text)
      const id = get().videoId
      if (!id) return
      if (get().meta?.status !== 'ready') {
        return set({ input: text, search: { kind: 'error', text, message: 'Questions work once the video is ready.' }, panelOpen: true })
      }
      set({ input: text, search: { kind: 'loading', text }, focus: null, panelOpen: true })
      const res = await api.query(id, text)
      const s = get().search
      if (!current(id) || s.kind !== 'loading' || s.text !== text) return
      if ('error' in res) set({ search: { kind: 'error', text, message: res.error } })
      else set({ search: { kind: 'answer', text, answer: res } })
    },

    clear: () => set({ input: '', search: { kind: 'idle' }, focus: null }),

    focusNearMiss(item) {
      set({ input: '', search: { kind: 'idle' }, focus: item })
      requestJump(item.f)
    },

    togglePanel: () => set({ panelOpen: !get().panelOpen }),
  }
})
