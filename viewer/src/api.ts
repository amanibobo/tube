import type { JobEvent, NearMiss, QueryResponse, Tubes, VideoId, VideoMeta } from './types'

export type PartialTubes = { tubes: Tubes; framesDone: number | null }

export type UploadResult = { ok: true; meta: VideoMeta } | { ok: false; message: string }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url} answered ${res.status}`)
  return (await res.json()) as T
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const scoped = (id: VideoId, path = '') => `/api/videos/${encodeURIComponent(id)}${path}`

type WireVideo = Tubes['video'] & { partial?: boolean; frames_done?: number }

/**
 * The hosted demo has no server: `VITE_STATIC=1` builds read a snapshot under /demo
 * (written by scripts/export-static.mjs) and answer only the questions it saved.
 */
export const STATIC = import.meta.env.VITE_STATIC === '1'
const demo = (id: VideoId, path = '') => `/demo/${encodeURIComponent(id)}${path}`
const thumbs = new Map<VideoId, { stride: number; last: number }>()
let answers: Promise<Record<string, Record<string, QueryResponse>>> | null = null

/** The server's cache key: lowercase words, punctuation dropped. */
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')

const staticApi = {
  videos: () => fetch('/demo/videos.json').then((r) => json<VideoMeta[]>(r)),
  video: (id: VideoId) => fetch(demo(id, '/meta.json')).then((r) => json<VideoMeta>(r)),
  warm: () => {},
  upload: async (): Promise<UploadResult> => ({ ok: false, message: 'Uploads need Tube running locally.' }),
  events: () => () => {},
  async tubes(id: VideoId): Promise<PartialTubes | null> {
    const tubes = await fetch(demo(id, '/tubes.json')).then((r) => json<Tubes>(r))
    const { thumb_stride: stride, frames } = tubes.video
    thumbs.set(id, { stride, last: Math.floor((frames - 1) / stride) * stride })
    return { tubes, framesDone: null }
  },
  nearMisses: (id: VideoId, topK: number) =>
    fetch(demo(id, '/near-misses.json'))
      .then((r) => json<{ list: NearMiss[] }>(r))
      .then((d) => d.list.slice(0, topK)),
  async query(id: VideoId, text: string): Promise<QueryResponse> {
    answers ??= fetch('/demo/answers.json').then((r) => json(r))
    const saved = (await answers)[id]?.[normalize(text)]
    return saved ?? { error: 'This demo answers the suggested questions. Run Tube locally to ask anything.' }
  },
  frameUrl(id: VideoId, f: number) {
    const t = thumbs.get(id) ?? { stride: 1, last: 0 }
    const nearest = Math.min(t.last, Math.max(0, Math.round(f / t.stride) * t.stride))
    return demo(id, `/frames/${String(nearest).padStart(6, '0')}.jpg`)
  },
  videoUrl: (id: VideoId) => demo(id, '/video.mp4'),
}

const serverApi = {
  videos: () => fetch('/api/videos').then((r) => json<VideoMeta[]>(r)),
  video: (id: VideoId) => fetch(scoped(id)).then((r) => json<VideoMeta>(r)),
  warm: (): void => {
    void fetch('/api/warm', { method: 'POST' }).catch(() => {})
  },

  upload(file: File, title: string, onProgress: (loaded: number, total: number) => void): Promise<UploadResult> {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/videos')
      xhr.upload.onprogress = (e) => onProgress(e.loaded, e.total)
      xhr.onload = () => {
        let body: { error?: string } | VideoMeta | null = null
        try {
          body = JSON.parse(xhr.responseText) as { error?: string } | VideoMeta
        } catch {
          body = null
        }
        if (xhr.status < 300 && body && 'id' in body) resolve({ ok: true, meta: body })
        else resolve({ ok: false, message: (body && 'error' in body && body.error) || `The upload failed (${xhr.status}).` })
      }
      xhr.onerror = () => resolve({ ok: false, message: 'The upload could not reach the server.' })
      const form = new FormData()
      form.append('file', file)
      form.append('title', title)
      xhr.send(form)
    })
  },

  events(id: VideoId, onEvent: (event: JobEvent) => void): () => void {
    const source = new EventSource(scoped(id, '/events'))
    source.onmessage = (e: MessageEvent<string>) => {
      const event = JSON.parse(e.data) as JobEvent
      if (event.type === 'done' || event.type === 'error') source.close()
      onEvent(event)
    }
    return () => source.close()
  },

  async tubes(id: VideoId): Promise<PartialTubes | null> {
    const res = await fetch(scoped(id, '/tubes'))
    if (res.status === 404 || res.status === 409) return null
    const { video, tracks } = await json<{ video: WireVideo; tracks: Tubes['tracks'] }>(res)
    const { partial, frames_done, ...clean } = video
    return { tubes: { video: clean, tracks }, framesDone: partial ? (frames_done ?? null) : null }
  },

  nearMisses: (id: VideoId, topK: number) =>
    fetch(scoped(id, `/near-misses?top_k=${topK}`))
      .then((r) => json<{ list: NearMiss[] }>(r))
      .then((d) => d.list),
  query: async (id: VideoId, text: string): Promise<QueryResponse> => {
    try {
      return await fetch(scoped(id, '/query'), send('POST', { text })).then((r) => json<QueryResponse>(r))
    } catch {
      return { error: 'The server could not answer that right now.' }
    }
  },
  frameUrl: (id: VideoId, f: number) => scoped(id, `/frames/${f}.jpg`),
  videoUrl: (id: VideoId) => scoped(id, '/video.mp4'),
}

export const api: typeof serverApi = STATIC ? staticApi : serverApi
