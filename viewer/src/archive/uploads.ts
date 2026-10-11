import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchJob, fetchJobs, jobActive, STAGES, startUrlUpload, uploadFile, type FilmId, type Job, type JobId, type Jobs, type Limits } from './api'

/**
 * One upload started in this tab, from the first byte to a searchable film (or the reason it is not one). `progress`
 * is the whole journey (transfer and server stages) in [0, 1] and never goes down.
 */
export type Upload =
  /** `sent` is the most bytes ever reported: a retried part restarts at 0, the count shown does not. */
  | { phase: 'sending'; key: string; title: string; size: number; sent: number; bytesPerSec: number; progress: number }
  /** The API has the video: a job record, polled until done or failed. */
  | { phase: 'server'; key: string; title: string; job: Job; progress: number }
  /** Never became a running job: refused by the API, a part failed every retry, or cancelled. */
  | { phase: 'refused'; key: string; title: string; message: string }

export const uploadActive = (u: Upload) => u.phase === 'sending' || (u.phase === 'server' && jobActive(u.job))

export type Source = Job['source']

/** The steps a journey passes: the browser's transfer for files, then the server's stages. */
export const stepsFor = (source: Source): readonly string[] =>
  source === 'file' ? ['uploading', ...STAGES.filter((s) => s !== 'downloading')] : STAGES

/** Each step's share of the journey, roughly its share of the wall time for a 30 s clip (captioning calls a remote model per shot). */
const WEIGHT: Record<string, number> = {
  uploading: 20, downloading: 20, probing: 2, converting: 8, 'detecting shots': 8, 'sampling frames': 8, 'building atlas': 4, embedding: 18, captioning: 40, publishing: 6,
}

/** Journey progress with `fraction` of `step` done. */
export function stepProgress(source: Source, step: string, fraction: number): number {
  const steps = stepsFor(source)
  const i = steps.indexOf(step)
  if (i < 0) return 0
  const total = steps.reduce((n, s) => n + WEIGHT[s]!, 0)
  const before = steps.slice(0, i).reduce((n, s) => n + WEIGHT[s]!, 0)
  return (before + WEIGHT[step]! * Math.min(1, Math.max(0, fraction))) / total
}

export function jobProgress(job: Job): number {
  if (job.state === 'done') return 1
  if (job.state === 'processing' && job.stage) return stepProgress(job.source, job.stage, job.total > 0 ? job.done / job.total : 0)
  return job.source === 'file' && job.state !== 'uploading' ? stepProgress('file', 'uploading', 1) : 0
}

const withJob = (u: Extract<Upload, { phase: 'server' }>, job: Job): Upload => ({ ...u, job, progress: Math.max(u.progress, jobProgress(job)) })

export interface Uploads {
  /** Newest first. */
  list: Upload[]
  /** The caller's jobs and quota from GET /api/jobs; null until it answers. */
  jobs: Jobs | null
  startFile: (file: File, title: string) => string
  startUrl: (url: string, title: string) => string
  cancel: (key: string) => void
  refreshJobs: (signal?: AbortSignal) => void
}

const VIDEO_EXTS = ['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.mpg', '.mpeg', '.ogv']
export const POLL_MS = 1500

/** Stage names arrive lowercase from the API; shown, they start a sentence. */
export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const formatBytes = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB` : `${(n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1)} MB`

/** The client-side refusal for a picked file, or null when the API should get it. */
export function checkFile(file: File, limits: Limits): string | null {
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : ''
  if (!file.type.startsWith('video/') && !VIDEO_EXTS.includes(ext)) return `${file.name} is not a video file.`
  if (file.size > limits.maxBytes) return `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(limits.maxBytes)}.`
  if (file.size === 0) return `${file.name} is empty.`
  return null
}

export const titleFrom = (name: string) => {
  const base = decodeURIComponent(name.split(/[?#]/)[0]!.split('/').filter(Boolean).at(-1) ?? '')
  return base.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 200)
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/**
 * Uploads and their jobs for the signed-in viewer (null: none, everything resets). Active jobs are polled every
 * POLL_MS; `onFilmReady` runs once per job that reaches done, with its film id.
 */
export function useUploads(viewer: string | null, onFilmReady: (filmId: FilmId) => void): Uploads {
  const [list, setList] = useState<Upload[]>([])
  const [jobs, setJobs] = useState<Jobs | null>(null)
  const aborts = useRef(new Map<string, AbortController>())
  const announced = useRef(new Set<JobId>())
  const nextKey = useRef(0)
  const ready = useRef(onFilmReady)
  ready.current = onFilmReady

  const update = useCallback((key: string, next: Upload) => setList((l) => l.map((u) => (u.key === key ? next : u))), [])

  const refreshJobs = useCallback((signal: AbortSignal = new AbortController().signal) => {
    if (!viewer) return
    fetchJobs(signal)
      .then((j) => {
        setJobs(j)
        // Jobs still running from an earlier visit get the same progress chip as ones started here.
        setList((l) => {
          const known = new Set(l.flatMap((u) => (u.phase === 'server' ? [u.job.id] : [])))
          const adopted = j.jobs.filter((job) => jobActive(job) && !known.has(job.id))
          return adopted.length ? [...l, ...adopted.map((job): Upload => ({ phase: 'server', key: job.id, title: job.title, job, progress: jobProgress(job) }))] : l
        })
      })
      .catch(() => {})
  }, [viewer])

  useEffect(() => {
    const running = aborts.current
    const ctrl = new AbortController()
    setList([])
    setJobs(null)
    refreshJobs(ctrl.signal)
    return () => { ctrl.abort(); for (const c of running.values()) c.abort(); running.clear() }
  }, [refreshJobs])

  const begin = useCallback((title: string, size: number, run: (key: string, signal: AbortSignal) => Promise<JobId>) => {
    const key = `u${nextKey.current++}`
    const ctrl = new AbortController()
    aborts.current.set(key, ctrl)
    setList((l) => [{ phase: 'sending', key, title, size, sent: 0, bytesPerSec: 0, progress: 0 }, ...l])
    run(key, ctrl.signal)
      .then((id) => fetchJob(id, ctrl.signal))
      .then((job) => update(key, { phase: 'server', key, title, job, progress: jobProgress(job) }))
      .catch((e: unknown) => update(key, { phase: 'refused', key, title, message: isAbort(e) ? 'Upload cancelled' : message(e) }))
      .finally(() => { aborts.current.delete(key); refreshJobs() })
    return key
  }, [update, refreshJobs])

  const startFile = useCallback((file: File, title: string) => begin(title, file.size, (key, signal) => {
    const t0 = performance.now()
    return uploadFile(file, title, (bytes) => {
      const s = (performance.now() - t0) / 1000
      setList((l) => l.map((u) => {
        if (u.key !== key || u.phase !== 'sending') return u
        const sent = Math.max(u.sent, bytes)
        return { ...u, sent, bytesPerSec: s > 0.2 ? sent / s : 0, progress: stepProgress('file', 'uploading', sent / file.size) }
      }))
    }, signal)
  }), [begin])

  const startUrl = useCallback((url: string, title: string) => begin(title, 0, () => startUrlUpload(title, url)), [begin])

  const cancel = useCallback((key: string) => aborts.current.get(key)?.abort(), [])

  const polled = list.flatMap((u) => (u.phase === 'server' && jobActive(u.job) ? [u.job.id] : [])).join(',')
  useEffect(() => {
    if (!polled) return
    const ctrl = new AbortController()
    const ids = polled.split(',') as JobId[]
    const tick = setInterval(() => {
      for (const id of ids) {
        fetchJob(id, ctrl.signal)
          .then((job) => {
            setList((l) => l.map((u) => (u.phase === 'server' && u.job.id === id ? withJob(u, job) : u)))
            if (job.state === 'done' && !announced.current.has(id)) {
              announced.current.add(id)
              ready.current(job.filmId)
            }
            if (!jobActive(job)) refreshJobs()
          })
          .catch(() => {})  // a missed poll is retried on the next tick
      }
    }, POLL_MS)
    return () => { clearInterval(tick); ctrl.abort() }
  }, [polled, refreshJobs])

  return { list, jobs, startFile, startUrl, cancel, refreshJobs }
}
