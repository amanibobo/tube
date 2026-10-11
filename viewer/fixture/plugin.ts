import { execFile } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Plugin } from 'vite'

type Px = [number, number]
type Status = 'queued' | 'processing' | 'ready' | 'failed'
type Stage = 'normalizing' | 'segmenting' | 'building' | 'indexing'
type Meta = {
  id: string
  title: string
  status: Status
  stage: Stage | null
  progress: number
  error: string | null
  created: string
  duration_s: number | null
  credit: string | null
  source: 'builtin' | 'upload'
  notice?: string
}
type VideoBlock = { id: string; fps: number; width: number; height: number; frames: number; thumb_stride: number; thumb_width: number; credit?: string }
type TrackFrame = { f: number; bbox: number[]; centroid: Px; contour: Px[] }
type Track = { id: number; class: string; first_frame: number; last_frame: number; frames: TrackFrame[] }
type NearMiss = { label: string; f: number; score: number; a: number; b: number; min_dist: number }

type Entry = {
  meta: Meta
  dir: string
  video: VideoBlock | null
  tracks: Track[]
  framesDone: number
  cache: Record<string, unknown>
  nearMisses: NearMiss[] | null
  listeners: Set<ServerResponse>
}

const run = promisify(execFile)
const DATA = new URL('../../data/', import.meta.url).pathname
const UPLOADS = process.env.FIXTURE_DIR ?? join(tmpdir(), 'tubewatch-fixture')
const STEP_MS = Number(process.env.FIXTURE_STEP_MS ?? 900)
const MAX_SECONDS = 120
const THUMB_STRIDE = 5
const BUILTIN_TITLES: Record<string, [string, string]> = {
  'pexels-junction': ['Junction, Pexels', '2026-10-09T12:00:00Z'],
  'astoria-20220723': ['Astoria, July 23 2022', '2026-10-08T12:00:00Z'],
  synthetic: ['Synthetic intersection', '2026-10-07T12:00:00Z'],
}

const videos = new Map<string, Entry>()
let builtinsLoaded: Promise<void> | null = null
let nextUpload = 1
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const normalize = (text: string) => text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean).join(' ')

function loadBuiltins() {
  builtinsLoaded ??= (async () => {
    for (const [id, [title, created]] of Object.entries(BUILTIN_TITLES)) {
      const dir = join(DATA, id)
      if (!existsSync(join(dir, 'tubes.json'))) continue
      const tubes = JSON.parse(await readFile(join(dir, 'tubes.json'), 'utf8')) as { video: VideoBlock; tracks: Track[] }
      const read = async <T>(name: string, fallback: T): Promise<T> =>
        existsSync(join(dir, name)) ? (JSON.parse(await readFile(join(dir, name), 'utf8')) as T) : fallback
      videos.set(id, {
        meta: {
          id,
          title,
          status: 'ready',
          stage: null,
          progress: 1,
          error: null,
          created,
          duration_s: tubes.video.frames / tubes.video.fps,
          credit: tubes.video.credit ?? null,
          source: 'builtin',
        },
        dir,
        video: tubes.video,
        tracks: tubes.tracks,
        framesDone: tubes.video.frames,
        cache: await read('agent_cache.json', {}),
        nearMisses: null,
        listeners: new Set(),
      })
    }
  })()
  return builtinsLoaded
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function sendFile(req: IncomingMessage, res: ServerResponse, path: string, type: string) {
  const size = (await stat(path)).size
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  if (!range) {
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' })
    createReadStream(path).pipe(res)
    return
  }
  const start = range[1] ? Number(range[1]) : 0
  const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  res.writeHead(206, {
    'content-type': type,
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${size}`,
    'accept-ranges': 'bytes',
  })
  createReadStream(path, { start, end }).pipe(res)
}

function multipartFile(raw: Buffer, contentType: string): { name: string; type: string; data: Buffer; title?: string } | null {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
  if (!boundary) return null
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
  let file: { name: string; type: string; data: Buffer } | null = null
  let title: string | undefined
  for (let at = raw.indexOf(delimiter); at !== -1; ) {
    const next = raw.indexOf(delimiter, at + delimiter.length)
    if (next === -1) break
    const part = raw.subarray(at + delimiter.length + 2, next - 2)
    const split = part.indexOf('\r\n\r\n')
    const headers = part.subarray(0, split).toString()
    const content = part.subarray(split + 4)
    const name = /name="([^"]*)"/.exec(headers)?.[1]
    if (name === 'file') {
      file = {
        name: /filename="([^"]*)"/.exec(headers)?.[1] ?? 'upload',
        type: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] ?? '',
        data: content,
      }
    } else if (name === 'title') title = content.toString()
    at = next
  }
  return file && { ...file, title }
}

function emit(entry: Entry, event: object) {
  for (const res of entry.listeners) res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function setStatus(entry: Entry, status: Status, stage: Stage | null, progress: number, message = '') {
  const moved = entry.meta.stage !== stage || entry.meta.status !== status || Math.abs(entry.meta.progress - progress) >= 0.02
  Object.assign(entry.meta, { status, stage, progress })
  if (moved) emit(entry, { type: 'status', status, stage, progress, message })
}

function finish(entry: Entry, event: { type: 'done' } | { type: 'error'; message: string }) {
  emit(entry, event)
  for (const res of entry.listeners) res.end()
  entry.listeners.clear()
}

async function probe(path: string): Promise<{ duration: number } | null> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', path])
    const info = JSON.parse(stdout) as { streams?: unknown[]; format?: { duration?: string } }
    const duration = Number(info.format?.duration)
    return info.streams?.length && duration > 0 ? { duration } : null
  } catch {
    return null
  }
}

let seed = 7
const rand = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}

function outline(cx: number, cy: number, rx: number, ry: number): Px[] {
  return Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2
    const r = 1 + 0.08 * Math.sin(a * 3 + cx * 0.01)
    return [Math.round(cx + Math.cos(a) * rx * r), Math.round(cy + Math.sin(a) * ry * r)]
  })
}

function fakeTrack(id: number, v: VideoBlock, from: number, to: number): Track {
  const isCar = id % 3 !== 0
  const parked = isCar && id % 4 === 1
  const s = v.width / 1920
  const start = from + Math.floor(rand() * Math.max(1, (to - from) * 0.5))
  const end = Math.min(to - 1, start + Math.floor((to - from) * (0.4 + rand() * 0.5)))
  const lane = isCar ? v.height * (0.52 + rand() * 0.24) : v.width * (0.15 + rand() * 0.7)
  const dir = rand() < 0.5 ? 1 : -1
  const frames: TrackFrame[] = []
  for (let f = start; f <= end; f++) {
    const t = parked ? 0.3 + (id % 5) * 0.1 : (f - start) / Math.max(1, end - start)
    const [cx, cy] = isCar
      ? [dir > 0 ? -100 * s + t * (v.width + 200 * s) : v.width + 100 * s - t * (v.width + 200 * s), lane]
      : [lane, v.height * (dir > 0 ? 0.2 + t * 0.7 : 0.9 - t * 0.7)]
    const [rx, ry] = isCar ? [110 * s, 55 * s] : [22 * s, 60 * s]
    frames.push({ f, bbox: [cx - rx, cy - ry, cx + rx, cy + ry], centroid: [Math.round(cx), Math.round(cy)], contour: outline(cx, cy, rx, ry) })
  }
  return { id, class: isCar ? 'car' : 'person', first_frame: start, last_frame: end, frames }
}

function computeNearMisses(entry: Entry): NearMiss[] {
  const closePx = (entry.video?.width ?? 1280) * 0.06
  const feet = (fr: TrackFrame): Px => [(fr.bbox[0]! + fr.bbox[2]!) / 2, fr.bbox[3]!]
  const people = entry.tracks.filter((t) => t.class === 'person')
  const vehicles = entry.tracks.filter((t) => t.class !== 'person' && t.class !== 'bicycle')
  const out: NearMiss[] = []
  for (const p of people) {
    for (const v of vehicles) {
      const from = Math.max(p.first_frame, v.first_frame)
      const to = Math.min(p.last_frame, v.last_frame)
      let best = { d: Infinity, f: 0 }
      for (let f = from; f <= to; f += 3) {
        const a = p.frames[f - p.first_frame]
        const b = v.frames[f - v.first_frame]
        if (!a || !b) continue
        const [ax, ay] = feet(a)
        const [bx, by] = feet(b)
        const d = Math.hypot(ax - bx, ay - by)
        if (d < best.d) best = { d, f }
      }
      if (best.d < closePx) {
        out.push({ label: `person ${p.id} and ${v.class} ${v.id}`, f: best.f, score: +(closePx / Math.max(best.d, 1)).toFixed(2), a: p.id, b: v.id, min_dist: +best.d.toFixed(1) })
      }
    }
  }
  return out.sort((x, y) => y.score - x.score)
}

function answer(entry: Entry, text: string): unknown {
  const cached = entry.cache[normalize(text)]
  if (cached) return { ...(cached as object), cached: true }
  if (!/close|near|danger/.test(text.toLowerCase())) return { error: 'No cached answer for that question while offline.' }
  const list = (entry.nearMisses ??= computeNearMisses(entry)).slice(0, 8)
  const half = Math.round((entry.video?.fps ?? 30) / 2)
  return {
    summary: list.length === 1 ? '1 time a person and a car came close.' : `${list.length} times a person and a car came close.`,
    highlight: {
      segments: list.flatMap((n) => [n.a, n.b].map((id) => ({ track_id: id, f_start: n.f - half, f_end: n.f + half, color: '#ff3b30' }))),
      list: list.map(({ label, f, score }) => ({ label, f, score })),
      caption: 'Person-car close passes',
    },
    cached: true,
  }
}

async function normalizeClip(entry: Entry, input: string) {
  const out = join(entry.dir, 'video.mp4')
  await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', input, '-t', String(MAX_SECONDS), '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out])
  setStatus(entry, 'processing', 'normalizing', 0.08)
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_packets', '-of', 'json', out])
  const s = (JSON.parse(stdout) as { streams: { width: number; height: number; r_frame_rate: string; nb_read_packets: string }[] }).streams[0]!
  const [num, den] = s.r_frame_rate.split('/').map(Number)
  const frames = Number(s.nb_read_packets)
  const frameDir = join(entry.dir, 'frames')
  await mkdir(frameDir, { recursive: true })
  await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', out, '-vf', `select='not(mod(n\\,${THUMB_STRIDE}))',scale=320:-2`, '-fps_mode', 'vfr', '-q:v', '5', join(frameDir, 't%06d.jpg')])
  const names = (await readdir(frameDir)).filter((n) => n.startsWith('t')).sort()
  await Promise.all(names.map((n, i) => rename(join(frameDir, n), join(frameDir, `${String(i * THUMB_STRIDE).padStart(6, '0')}.jpg`))))
  const fps = +(num! / (den || 1)).toFixed(3)
  entry.video = { id: entry.meta.id, fps, width: s.width, height: s.height, frames, thumb_stride: THUMB_STRIDE, thumb_width: 320 }
  entry.meta.duration_s = frames / fps
}

async function runJob(entry: Entry, input: string, readable: boolean) {
  await wait(STEP_MS / 3)
  setStatus(entry, 'processing', 'normalizing', 0.02, 'Preparing video')
  if (!readable) {
    await wait(STEP_MS)
    entry.meta.status = 'failed'
    entry.meta.error = 'This file could not be read as a video.'
    return finish(entry, { type: 'error', message: entry.meta.error })
  }
  await normalizeClip(entry, input)
  await wait(STEP_MS)
  const video = entry.video!
  const chunks = 4
  const per = Math.max(3, Math.round((video.frames / video.fps / 10) * 4))
  setStatus(entry, 'processing', 'segmenting', 0.15, 'Finding cars and people')
  for (let c = 0; c < chunks; c++) {
    await wait(STEP_MS)
    const from = Math.floor((c / chunks) * video.frames)
    const to = Math.floor(((c + 1) / chunks) * video.frames)
    for (let i = 0; i < per; i++) entry.tracks.push(fakeTrack(entry.tracks.length + 1, video, from, to))
    entry.framesDone = to
    setStatus(entry, 'processing', 'segmenting', 0.15 + (0.6 * (c + 1)) / chunks)
    emit(entry, { type: 'tubes', frames_done: to, tracks: entry.tracks.length })
  }
  setStatus(entry, 'processing', 'building', 0.8, 'Building tubes')
  await wait(STEP_MS)
  setStatus(entry, 'processing', 'indexing', 0.92, 'Indexing')
  entry.nearMisses = computeNearMisses(entry)
  await wait(STEP_MS)
  setStatus(entry, 'ready', null, 1)
  finish(entry, { type: 'done' })
}

async function upload(req: IncomingMessage, res: ServerResponse) {
  const file = multipartFile(await body(req), req.headers['content-type'] ?? '')
  if (!file) return send(res, 400, { error: 'The upload had no file in it.' })
  const looksLikeVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)
  if (!looksLikeVideo) return send(res, 400, { error: 'That file is not a video.' })
  const id = `upload-${Date.now().toString(36)}-${nextUpload++}`
  const dir = join(UPLOADS, id)
  await mkdir(dir, { recursive: true })
  const input = join(dir, `source${/\.[a-z0-9]+$/i.exec(file.name)?.[0] ?? '.mp4'}`)
  await writeFile(input, file.data)
  const probed = await probe(input)
  const meta: Meta = {
    id,
    title: file.title?.trim() || file.name.replace(/\.[^.]+$/, ''),
    status: 'queued',
    stage: null,
    progress: 0,
    error: null,
    created: new Date().toISOString(),
    duration_s: probed ? Math.min(probed.duration, MAX_SECONDS) : null,
    credit: null,
    source: 'upload',
  }
  if (probed && probed.duration > MAX_SECONDS) meta.notice = 'Trimmed to the first 2 minutes.'
  const entry: Entry = { meta, dir, video: null, tracks: [], framesDone: 0, cache: {}, nearMisses: null, listeners: new Set() }
  videos.set(id, entry)
  void runJob(entry, input, probed !== null).catch((err: Error) => {
    entry.meta.status = 'failed'
    entry.meta.error = 'Processing stopped unexpectedly.'
    console.error('[fixture] job failed', err.message)
    finish(entry, { type: 'error', message: entry.meta.error })
  })
  send(res, 200, meta)
}

function events(entry: Entry, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const { status, stage, progress, error } = entry.meta
  if (status === 'ready') return res.end(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
  if (status === 'failed') return res.end(`data: ${JSON.stringify({ type: 'error', message: error })}\n\n`)
  res.write(`data: ${JSON.stringify({ type: 'status', status, stage, progress, message: '' })}\n\n`)
  entry.listeners.add(res)
  res.on('close', () => entry.listeners.delete(res))
}

async function route(req: IncomingMessage, res: ServerResponse) {
  await loadBuiltins()
  const url = new URL(req.url ?? '/', 'http://fixture')
  const method = req.method ?? 'GET'
  if (url.pathname === '/api/warm' && method === 'POST') return send(res, 200, { ok: true })
  if (url.pathname === '/api/videos') {
    if (method === 'POST') return upload(req, res)
    const list = [...videos.values()].map((e) => e.meta).sort((a, b) => b.created.localeCompare(a.created))
    return send(res, 200, list)
  }
  const m = /^\/api\/videos\/([^/]+)(?:\/(.*))?$/.exec(url.pathname)
  const entry = m && videos.get(decodeURIComponent(m[1]!))
  if (!m || !entry) return send(res, 404, { error: 'Not found.' })
  const rest = m[2] ?? ''
  const normalized = entry.video !== null

  if (rest === '') return send(res, 200, entry.meta)
  if (rest === 'events') return events(entry, res)
  if (rest === 'tubes') {
    if (!entry.video) return send(res, 404, { error: 'Not ready yet.' })
    const partial = entry.meta.status !== 'ready'
    const video = partial ? { ...entry.video, partial: true, frames_done: entry.framesDone } : entry.video
    return send(res, 200, { video, tracks: entry.tracks })
  }
  if (rest === 'video.mp4' && normalized) return sendFile(req, res, join(entry.dir, 'video.mp4'), 'video/mp4')
  const frame = /^frames\/(\d+)\.jpg$/.exec(rest)
  if (frame && entry.video) {
    const stride = entry.video.thumb_stride
    const last = Math.floor((entry.video.frames - 1) / stride) * stride
    const f = Math.min(last, Math.round(Number(frame[1]) / stride) * stride)
    return sendFile(req, res, join(entry.dir, 'frames', `${String(f).padStart(6, '0')}.jpg`), 'image/jpeg')
  }
  if (rest === 'near-misses') {
    if (entry.meta.status !== 'ready') return send(res, 200, { list: [] })
    const topK = Number(url.searchParams.get('top_k') ?? 10)
    return send(res, 200, { list: (entry.nearMisses ??= computeNearMisses(entry)).slice(0, topK) })
  }
  if (rest === 'query' && method === 'POST') {
    if (entry.meta.status !== 'ready') return send(res, 200, { error: 'Questions work once the video is ready.' })
    const { text } = JSON.parse((await body(req)).toString()) as { text: string }
    await wait(300)
    return send(res, 200, answer(entry, text))
  }
  send(res, 404, { error: 'Not found.' })
}

export function fixture(): Plugin {
  return {
    name: 'tubewatch-fixture',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next()
        route(req, res).catch((err: Error) => {
          console.error('[fixture]', err)
          if (!res.headersSent) send(res, 500, { error: err.message })
        })
      })
    },
  }
}
