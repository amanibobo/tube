export type FilmId = string & { readonly __brand: 'FilmId' }

export interface Atlas { cellW: number; cellH: number; cols: number; perPage: number; pages: number; urls: string[] }
export interface Film { id: FilmId; title: string; duration: number; sampleFps: number; nFrames: number; atlas: Atlas; videoUrl: string; shots: [number, number][]; ownerIsYou: boolean }
export interface Moment { rank: number; filmId: FilmId; title: string; t: number; start: number; end: number; frame: number; frameRange: [number, number]; caption: string | null; similarity: number }

export type Search =
  | { status: 'idle' }
  | { status: 'loading'; query: string; since: number }
  | { status: 'ready'; query: string; moments: Moment[]; heat: Map<FilmId, Uint8Array>; tookMs: number }
  | { status: 'error'; query: string; message: string }

/** The archive's own load: the API waking up, then the strips' atlas pages arriving. */
export type Library =
  | { status: 'waking'; since: number }
  | { status: 'error'; message: string }
  /** Atlas pages still arriving; `settled` holds the URLs that loaded or were given up on after retries. */
  | { status: 'frames'; films: Film[]; settled: ReadonlySet<string> }
  | { status: 'ready'; films: Film[] }

export const atlasPageCount = (films: readonly Film[]) => films.reduce((n, f) => n + f.atlas.urls.length, 0)

export function libraryLoaded(films: Film[]): Library {
  return atlasPageCount(films) === 0 ? { status: 'ready', films } : { status: 'frames', films, settled: new Set() }
}

/** A refetch after the archive has shown (sign-in, a finished upload, a delete) swaps the films in place: new strips pop in as their pages load. */
export function libraryRefreshed(library: Library, films: Film[]): Library {
  if (library.status === 'ready') return { status: 'ready', films }
  if (library.status !== 'frames') return libraryLoaded(films)
  const urls = new Set(films.flatMap((f) => f.atlas.urls))
  const settled = new Set([...library.settled].filter((u) => urls.has(u)))
  return settled.size >= urls.size ? { status: 'ready', films } : { status: 'frames', films, settled }
}

export function pageSettled(library: Library, url: string): Library {
  if (library.status !== 'frames' || library.settled.has(url)) return library
  const settled = new Set(library.settled).add(url)
  return settled.size >= atlasPageCount(library.films) ? { status: 'ready', films: library.films } : { ...library, settled }
}

export type Hover = { kind: 'none' } | { kind: 'frame'; filmId: FilmId; frame: number; moment: Moment | null }

type Json = Record<string, unknown>

/** vidsearch's live deployment. CORS is open, so the archive calls it directly from dev and from the hosted build. */
const DEFAULT_API = 'https://amanibobo1--vidsearch-traffic-web.modal.run'
const API = String(import.meta.env.VITE_ARCHIVE_API || DEFAULT_API)
/** The library and search answer with paths (`/media/...`, `/api/video/...`); every one resolves against the API. */
const api = (path: string) => new URL(path, API).href

function obj(v: unknown, what: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what}: expected object`)
  return v as Json
}
function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what}: expected number`)
  return v
}
function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`${what}: expected string`)
  return v
}
function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${what}: expected boolean`)
  return v
}
function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what}: expected array`)
  return v
}
function pair(v: unknown, what: string): [number, number] {
  const a = arr(v, what)
  return [num(a[0], what), num(a[1], what)]
}

function parseFilm(v: unknown): Film {
  const f = obj(v, 'film')
  const a = obj(f.atlas, 'film.atlas')
  return {
    id: str(f.id, 'film.id') as FilmId,
    title: str(f.title, 'film.title'),
    duration: num(f.duration, 'film.duration'),
    sampleFps: num(f.sample_fps, 'film.sample_fps'),
    nFrames: num(f.n_frames, 'film.n_frames'),
    atlas: {
      cellW: num(a.cell_w, 'atlas.cell_w'),
      cellH: num(a.cell_h, 'atlas.cell_h'),
      cols: num(a.cols, 'atlas.cols'),
      perPage: num(a.per_page, 'atlas.per_page'),
      pages: num(a.pages, 'atlas.pages'),
      urls: arr(a.urls, 'atlas.urls').map((u) => api(str(u, 'atlas.urls[]'))),
    },
    videoUrl: api(str(f.video_url, 'film.video_url')),
    shots: arr(f.shots, 'film.shots').map((s) => pair(s, 'film.shots[]')),
    ownerIsYou: f.owner_is_you === undefined ? false : bool(f.owner_is_you, 'film.owner_is_you'),
  }
}

function parseMoment(v: unknown): Moment {
  const m = obj(v, 'result')
  return {
    rank: num(m.rank, 'result.rank'),
    filmId: str(m.film_id, 'result.film_id') as FilmId,
    title: str(m.title, 'result.title'),
    t: num(m.t, 'result.t'),
    start: num(m.start, 'result.start'),
    end: num(m.end, 'result.end'),
    frame: num(m.frame, 'result.frame'),
    frameRange: pair(m.frame_range, 'result.frame_range'),
    caption: m.caption == null ? null : str(m.caption, 'result.caption'),
    similarity: num(m.similarity, 'result.similarity'),
  }
}

/** The sampled frame JPEG; the library payload does not list these, the path mirrors vidsearch/library.py. */
export const frameStillUrl = (film: FilmId, frame: number) => api(`/media/${film}/frames/${String(frame).padStart(6, '0')}.jpg`)

function decodeHeat(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

export class HttpError extends Error {
  /** `detail` is the API's own explanation (FastAPI's `{"detail": "..."}`), meant for the user. */
  constructor(readonly status: number, url: string, readonly detail: string | null = null) { super(detail ?? `${url} failed: HTTP ${status}`) }
}

async function httpError(res: Response, url: string): Promise<HttpError> {
  const body: unknown = await res.json().catch(() => null)
  const detail = typeof body === 'object' && body !== null && 'detail' in body && typeof body.detail === 'string' ? body.detail : null
  return new HttpError(res.status, url.split('?')[0]!, detail)
}

/** Where signed-in requests get their bearer token; null while signed out (or sign-in is off). A device id is the fallback. */
export interface TokenSource {
  /** `fresh` skips any cached token, for the one retry after a 401. */
  token(fresh: boolean): Promise<string>
  /** The API refused a fresh token too: end the session and tell the user. */
  expired(): void
}

export const SESSION_EXPIRED = 'Your session expired. Sign in again.'

let tokens: TokenSource | null = null
export function setTokenSource(source: TokenSource | null) { tokens = source }

/** This browser's upload identity (see device.ts), sent when no account is signed in; null sends nothing. */
let device: TokenSource | null = null
export function setDeviceId(id: string | null) {
  device = id ? { token: async () => `device:${id}`, expired: () => {} } : null
}

type Headers = Record<string, string>

/** One HTTP exchange with the caller's bearer token. A 401 gets one retry with a fresh token, then signs the user out. */
async function authed<T extends { status: number }>(send: (headers: Headers) => Promise<T>): Promise<T> {
  const source = tokens ?? device
  if (!source) return send({})
  const bearer = async (fresh: boolean): Promise<Headers> => {
    try {
      return { Authorization: `Bearer ${await source.token(fresh)}` }
    } catch {
      source.expired()
      throw new HttpError(401, 'sign-in', SESSION_EXPIRED)
    }
  }
  const first = await send(await bearer(false))
  if (first.status !== 401) return first
  const second = await send(await bearer(true))
  if (second.status === 401) source.expired()
  return second
}

/**
 * The production API scales to zero: the first requests after idle wait for a container and can drop or 5xx meanwhile.
 * Transient failures retry with doubling backoff until `retries` or `deadlineMs` (from the first attempt) runs out.
 */
interface RetryPolicy { retries: number; deadlineMs: number }
const LIBRARY_RETRY: RetryPolicy = { retries: Infinity, deadlineMs: 60_000 }
const SEARCH_RETRY: RetryPolicy = { retries: 2, deadlineMs: Infinity }
const POLL_RETRY: RetryPolicy = { retries: 1, deadlineMs: Infinity }
const PART_RETRY: RetryPolicy = { retries: 4, deadlineMs: Infinity }
const backoffMs = (attempt: number) => Math.min(8000, 1000 * 2 ** attempt)
const transient = (e: unknown) => e instanceof TypeError || (e instanceof HttpError && e.status >= 500)

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function withRetry<T>(policy: RetryPolicy, signal: AbortSignal, attempt: () => Promise<T>): Promise<T> {
  const started = Date.now()
  for (let n = 0; ; n++) {
    try {
      return await attempt()
    } catch (e) {
      const wait = backoffMs(n)
      if (!transient(e) || n >= policy.retries || Date.now() - started + wait > policy.deadlineMs) throw e
      await sleep(wait, signal)
    }
  }
}

async function getJson(url: string, policy: RetryPolicy, signal: AbortSignal): Promise<unknown> {
  return withRetry(policy, signal, async () => {
    const res = await authed((headers) => fetch(url, { signal, headers }))
    if (!res.ok) throw await httpError(res, url)
    return res.json()
  })
}

/** POST/DELETE are not retried: a repeated POST /api/uploads would spend another of the day's uploads. */
async function sendJson(method: 'POST' | 'DELETE', path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const url = api(path)
  const res = await authed((headers) => fetch(url, {
    method,
    signal,
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  if (!res.ok) throw await httpError(res, url)
  return res.json()
}

/** What the API offers: `account` uploads need sign-in, `device` uploads are tied to this browser, `off` none. */
export type UploadsMode = 'off' | 'device' | 'account'
const UPLOADS_MODES: readonly UploadsMode[] = ['off', 'device', 'account']

/** What the archive and one of its items are called (`The Traffic Archive`, `clip`); each collection's API says. */
export interface Identity { title: string; noun: string; nounPlural: string }

/**
 * Until the API answers, and for an API from before `archive` existed. The page's own title is Tube's, so it is not
 * a fallback here.
 */
export const FALLBACK_IDENTITY: Identity = { title: 'The Traffic Archive', noun: 'clip', nounPlural: 'clips' }

/** `voice`: the API can mint voice search tokens (it has an ElevenLabs key), so the pill offers the mic. */
export interface Archive { films: Film[]; uploads: UploadsMode; identity: Identity; voice: boolean }

function parseIdentity(v: unknown): Identity {
  const a = obj(v, 'library.archive')
  return { title: str(a.title, 'archive.title'), noun: str(a.noun, 'archive.noun'), nounPlural: str(a.noun_plural, 'archive.noun_plural') }
}

export async function fetchLibrary(signal: AbortSignal): Promise<Archive> {
  const body = obj(await getJson(api('/api/library'), LIBRARY_RETRY, signal), 'library')
  // An API from before `uploads` existed offered sign-in whenever it had Auth0.
  const mode = body.uploads === undefined ? 'account' : str(obj(body.uploads, 'library.uploads').mode, 'uploads.mode')
  if (!UPLOADS_MODES.includes(mode as UploadsMode)) throw new Error(`uploads.mode: unknown mode ${mode}`)
  return {
    films: arr(body.films, 'library.films').map(parseFilm),
    uploads: mode as UploadsMode,
    identity: body.archive === undefined ? FALLBACK_IDENTITY : parseIdentity(body.archive),
    voice: body.voice === undefined ? false : bool(obj(body.voice, 'library.voice').available, 'voice.available'),
  }
}

/** A single-use ElevenLabs realtime token. Not retried: each one spends the archive's voice credits. */
export async function fetchVoiceToken(signal: AbortSignal): Promise<string> {
  const url = api('/api/voice/token')
  const res = await authed((headers) => fetch(url, { signal, headers }))
  if (!res.ok) throw await httpError(res, url)
  return str(obj(await res.json(), 'voice').token, 'voice.token')
}

export async function runSearch(query: string, signal: AbortSignal): Promise<Extract<Search, { status: 'ready' }>> {
  const q = encodeURIComponent(query)
  const found = obj(await getJson(api(`/api/search?q=${q}&heatmap=1`), SEARCH_RETRY, signal), 'search')
  const heatmap = obj(found.heatmap, 'search.heatmap')
  const heat = new Map<FilmId, Uint8Array>()
  for (const [id, b64] of Object.entries(obj(heatmap.films, 'heatmap.films'))) {
    heat.set(id as FilmId, decodeHeat(str(b64, `heatmap.films.${id}`)))
  }
  return {
    status: 'ready',
    query,
    moments: arr(found.results, 'search.results').map(parseMoment),
    heat,
    tookMs: num(found.took_ms, 'search.took_ms'),
  }
}

export function momentAt(moments: readonly Moment[], filmId: FilmId, frame: number): Moment | null {
  return moments.find((m) => m.filmId === filmId && frame >= m.frameRange[0] && frame < m.frameRange[1]) ?? null
}

// ---------------------------------------------------------------- uploads and jobs (signed in)

export type JobId = string & { readonly __brand: 'JobId' }
export type JobState = 'uploading' | 'queued' | 'processing' | 'done' | 'failed'
const JOB_STATES: readonly JobState[] = ['uploading', 'queued', 'processing', 'done', 'failed']

/** The pipeline's stages in the order a job passes them; `downloading` only for URL uploads. */
export const STAGES = ['downloading', 'probing', 'converting', 'detecting shots', 'sampling frames', 'building atlas', 'embedding', 'captioning', 'publishing'] as const

export interface Job {
  id: JobId
  title: string
  filmId: FilmId
  source: 'file' | 'url'
  state: JobState
  /** One of STAGES while processing; null otherwise. */
  stage: string | null
  done: number
  total: number
  /** failed: why. done: set when captions were skipped. */
  error: string | null
  created: number
}

export interface Limits { uploadsPerDay: number; maxBytes: number; maxMinutes: number }
export interface Jobs { jobs: Job[]; uploadsToday: number; limits: Limits }

export const jobActive = (job: Job) => job.state === 'queued' || job.state === 'processing'

function parseJob(v: unknown): Job {
  const j = obj(v, 'job')
  const state = str(j.state, 'job.state') as JobState
  if (!JOB_STATES.includes(state)) throw new Error(`job.state: unknown state ${state}`)
  const source = str(j.source, 'job.source')
  if (source !== 'file' && source !== 'url') throw new Error(`job.source: unknown source ${source}`)
  return {
    id: str(j.id, 'job.id') as JobId,
    title: str(j.title, 'job.title'),
    filmId: str(j.film_id, 'job.film_id') as FilmId,
    source,
    state,
    stage: j.stage == null ? null : str(j.stage, 'job.stage'),
    done: num(j.done, 'job.done'),
    total: num(j.total, 'job.total'),
    error: j.error == null ? null : str(j.error, 'job.error'),
    created: num(j.created, 'job.created'),
  }
}

export async function fetchJobs(signal: AbortSignal): Promise<Jobs> {
  const body = obj(await getJson(api('/api/jobs'), POLL_RETRY, signal), 'jobs')
  const limits = obj(body.limits, 'jobs.limits')
  return {
    jobs: arr(body.jobs, 'jobs.jobs').map(parseJob),
    uploadsToday: num(body.uploads_today, 'jobs.uploads_today'),
    limits: {
      uploadsPerDay: num(limits.uploads_per_day, 'limits.uploads_per_day'),
      maxBytes: num(limits.max_bytes, 'limits.max_bytes'),
      maxMinutes: num(limits.max_minutes, 'limits.max_minutes'),
    },
  }
}

export async function fetchJob(id: JobId, signal: AbortSignal): Promise<Job> {
  return parseJob(await getJson(api(`/api/jobs/${id}`), POLL_RETRY, signal))
}

export async function startUrlUpload(title: string, url: string): Promise<JobId> {
  return str(obj(await sendJson('POST', '/api/uploads/url', { title, url }), 'upload').job_id, 'upload.job_id') as JobId
}

export async function deleteFilm(id: FilmId): Promise<void> {
  await sendJson('DELETE', `/api/films/${encodeURIComponent(id)}`, undefined)
}

const PART_CONCURRENCY = 3

/**
 * PUT one part with upload progress (fetch can't report request-body progress). Resolves with the status;
 * rejects with a TypeError on a network failure, like fetch, so it counts as transient.
 */
function putBytes(url: string, body: Blob, headers: Headers, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<{ status: number; xhr: XMLHttpRequest }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    xhr.open('PUT', url)
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () => { signal.removeEventListener('abort', abort); resolve({ status: xhr.status, xhr }) }
    xhr.onerror = () => { signal.removeEventListener('abort', abort); reject(new TypeError(`network error sending ${url}`)) }
    xhr.onabort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    xhr.send(body)
  })
}

async function putPart(url: string, part: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<void> {
  await withRetry(PART_RETRY, signal, async () => {
    onProgress(0)
    const { status, xhr } = await authed((headers) => putBytes(url, part, headers, onProgress, signal))
    if (status < 200 || status >= 300) {
      const detail = (() => { try { return (JSON.parse(xhr.responseText) as { detail?: unknown }).detail } catch { return null } })()
      throw new HttpError(status, url, typeof detail === 'string' ? detail : null)
    }
  })
}

/**
 * Sends a file the way the API takes it: start (spends one of the day's uploads), PUT every part with a few in
 * flight and each retried on network errors and 5xx, then complete. Resolves with the job now processing it.
 */
export async function uploadFile(file: File, title: string, onSent: (bytes: number) => void, signal: AbortSignal): Promise<JobId> {
  const started = obj(await sendJson('POST', '/api/uploads', { title, filename: file.name, size: file.size }, signal), 'upload')
  const id = str(started.upload_id, 'upload.upload_id') as JobId
  const partSize = num(started.part_size, 'upload.part_size')
  const parts = num(started.parts, 'upload.parts')
  const sent = new Float64Array(parts)
  const report = () => onSent(sent.reduce((a, b) => a + b, 0))
  // The first part that fails for good stops the others.
  const stop = new AbortController()
  const onAbort = () => stop.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  let next = 0
  const worker = async () => {
    while (next < parts) {
      const n = next++
      const blob = file.slice(n * partSize, Math.min(file.size, (n + 1) * partSize))
      await putPart(api(`/api/uploads/${id}/parts/${n}`), blob, (loaded) => { sent[n] = loaded; report() }, stop.signal)
      sent[n] = blob.size
      report()
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, parts) }, () => worker().catch((e: unknown) => { stop.abort(e); throw e })))
    await sendJson('POST', `/api/uploads/${id}/complete`, { parts }, signal)
  } catch (e) {
    // Cancelled, or a part failed for good: give the day's upload back before reporting it. An upload that did
    // complete despite the error answers 409 and keeps running.
    await sendJson('DELETE', `/api/uploads/${id}`, undefined).catch(() => {})
    throw e
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  return id
}
