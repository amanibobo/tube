import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import { deleteFilm, frameStillUrl, type Film, type FilmId, type Job, type JobId, type Jobs } from './api'
import { checkFile, formatBytes, sentence, stepsFor, titleFrom, uploadActive, type Source, type Upload, type Uploads } from './uploads'

export type Tab = 'upload' | 'mine'

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const DEVICE_NOTE = 'Uploads are tied to this browser. Clearing site data loses access.'
const CLOSE_MS = 160

/** The uploads panel: `upload` and `my uploads` tabs in one card that stays put and eases its height between them. */
export function Panel({ tab, closing, onTab, onClose, onClosed, noun, uploads, films, viewing, onView, browserOnly, onLibraryChanged, onShowFilm }: {
  tab: Tab
  closing: boolean
  onTab: (tab: Tab) => void
  onClose: () => void
  /** The close animation has played; unmount. */
  onClosed: () => void
  noun: string
  uploads: Uploads
  films: readonly Film[]
  viewing: string | null
  onView: (key: string | null) => void
  browserOnly: boolean
  onLibraryChanged: () => void
  onShowFilm: (id: FilmId) => void
}) {
  const closed = useRef(onClosed)
  closed.current = onClosed
  useEffect(() => {
    if (!closing) return
    const t = setTimeout(() => closed.current(), CLOSE_MS)
    return () => clearTimeout(t)
  }, [closing])

  return (
    <section className={`panel ${tab}${closing ? ' closing' : ''}`} aria-label="Uploads">
      <header className="panel-head">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" className="tab" aria-selected={tab === 'upload'} onClick={() => onTab('upload')}>Upload</button>
          <button type="button" role="tab" className="tab" aria-selected={tab === 'mine'} onClick={() => onTab('mine')}>My uploads</button>
        </div>
        <QuotaMeter jobs={uploads.jobs} />
        <button type="button" className="panel-close" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <AutoHeight>
        <div className="tab-pane" key={tab} role="tabpanel">
          {tab === 'upload'
            ? <UploadTab noun={noun} uploads={uploads} viewing={viewing} onView={onView} onShowFilm={onShowFilm} />
            : <MyUploads noun={noun} uploads={uploads} films={films} onTab={onTab} onLibraryChanged={onLibraryChanged} onShowFilm={onShowFilm} />}
        </div>
      </AutoHeight>
      {browserOnly && <footer className="panel-foot"><span className="browser-note" title={DEVICE_NOTE}>Saved to this browser</span></footer>}
    </section>
  )
}

/** Eases its own height to its content's (a CSS transition on an explicit height). Clips while it moves so no scrollbar flashes. */
function AutoHeight({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const o = outer.current, i = inner.current
    if (!o || !i) return
    let last = -1
    const ro = new ResizeObserver(([entry]) => {
      const h = Math.ceil(entry!.borderBoxSize[0]!.blockSize)
      if (h === last) return
      if (last >= 0) o.classList.add('resizing')
      last = h
      o.style.height = `${h}px`
    })
    const settled = (e: TransitionEvent) => { if (e.target === o) o.classList.remove('resizing') }
    ro.observe(i)
    o.addEventListener('transitionend', settled)
    o.addEventListener('transitioncancel', settled)
    return () => { ro.disconnect(); o.removeEventListener('transitionend', settled); o.removeEventListener('transitioncancel', settled) }
  }, [])
  return <div className="panel-body" ref={outer}><div ref={inner}>{children}</div></div>
}

const quotaLeft = (jobs: Jobs | null) => (jobs ? Math.max(0, jobs.limits.uploadsPerDay - jobs.uploadsToday) : 0)

function QuotaMeter({ jobs }: { jobs: Jobs | null }) {
  if (!jobs) return <span className="quota-meter" role="img" aria-label="Checking today’s uploads" />
  const per = jobs.limits.uploadsPerDay
  const left = quotaLeft(jobs)
  const label = left ? `${left} of ${per} uploads left today` : 'No uploads left today. More after 00:00 UTC.'
  return (
    <span className="quota-meter" role="img" aria-label={label} title={label}>
      {per <= 10 ? Array.from({ length: per }, (_, i) => <i key={i} data-used={i < per - left || undefined} />) : `${left} left`}
    </span>
  )
}

function Bar({ value }: { value: number }) {
  return (
    <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={+(value * 100).toFixed(1)}>
      <span style={{ transform: `scaleX(${value})` }} />
    </div>
  )
}

const asPercent = (v: number) => `${Math.floor(100 * v)}%`

/** A percentage that counts up to `value` over ~1 s and never counts down. Writes its text directly: no render per frame. */
export function Percent({ value }: { value: number }) {
  const el = useRef<HTMLSpanElement>(null)
  const shown = useRef(value)
  useLayoutEffect(() => { if (el.current) el.current.textContent = asPercent(shown.current) }, [])
  useEffect(() => {
    const from = shown.current, to = Math.max(from, value)
    if (to === from) return
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      // A frame's timestamp can precede t0 (it is the frame's start); clamp so the ease never dips below `from`.
      const k = Math.min(1, Math.max(0, (now - t0) / 1000))
      shown.current = from + (to - from) * (1 - (1 - k) ** 3)
      if (el.current) el.current.textContent = asPercent(shown.current)
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <span className="percent" ref={el} />
}

const Check = () => <svg className="check" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-5" /></svg>

// ---------------------------------------------------------------- upload tab

function UploadTab({ noun, uploads, viewing, onView, onShowFilm }: { noun: string; uploads: Uploads; viewing: string | null; onView: (key: string | null) => void; onShowFilm: (id: FilmId) => void }) {
  const shown = uploads.list.find((u) => u.key === viewing)
  return shown
    ? <Journey upload={shown} onCancel={() => uploads.cancel(shown.key)} onAnother={() => onView(null)} onShowFilm={onShowFilm} />
    : <UploadForm noun={noun} uploads={uploads} onStarted={onView} />
}

type Picked = { kind: 'none' } | { kind: 'file'; file: File } | { kind: 'url'; url: string }

function UploadForm({ noun, uploads, onStarted }: { noun: string; uploads: Uploads; onStarted: (key: string) => void }) {
  const [source, setSource] = useState<Picked>({ kind: 'none' })
  const [title, setTitle] = useState('')
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const limits = uploads.jobs?.limits
  const left = quotaLeft(uploads.jobs)
  const file = source.kind === 'file' ? source.file : null
  const refusal = file && limits ? checkFile(file, limits) : null
  const fallback = file ? titleFrom(file.name) : source.kind === 'url' ? titleFrom(source.url) : ''
  const name = title.trim() || fallback
  const ready = source.kind !== 'none' && !!name && !refusal && left > 0

  const pickFile = (f: File | undefined) => { if (f) setSource({ kind: 'file', file: f }) }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); pickFile(e.dataTransfer.files[0]) }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    onStarted(source.kind === 'file' ? uploads.startFile(source.file, name) : uploads.startUrl(source.url.trim(), name))
  }

  return (
    <form className="upload-form" onSubmit={submit}>
      <div
        className={['drop', dragging && 'over', file && 'chosen'].filter(Boolean).join(' ')}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {file ? (
          <p className="drop-file"><span className="drop-name">{file.name}</span> <span className="drop-size">{formatBytes(file.size)}</span></p>
        ) : (
          <p className="drop-line">Drop a video here</p>
        )}
        <button type="button" className="text-button" onClick={() => picker.current?.click()}>{file ? 'Choose another' : 'Or choose a file'}</button>
        <p className="drop-hint">Up to {limits ? formatBytes(limits.maxBytes) : '2 GB'} and {limits?.maxMinutes ?? 60} min</p>
        <input ref={picker} type="file" accept="video/*" hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = '' }} />
      </div>
      <label className="field">
        <span>Or paste a direct video link</span>
        <input
          name="url"
          type="text"
          inputMode="url"
          placeholder={`https://…/${noun}.mp4`}
          spellCheck={false}
          value={source.kind === 'url' ? source.url : ''}
          onChange={(e) => setSource(e.target.value ? { kind: 'url', url: e.target.value } : { kind: 'none' })}
        />
      </label>
      <label className="field">
        <span>Title</span>
        <input name="title" type="text" maxLength={200} placeholder={fallback || 'Defaults to the file name'} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      {refusal && <p className="upload-error" role="alert">{refusal}</p>}
      <div className="upload-foot">
        <span className="form-note">{uploads.jobs && !left ? 'No uploads left today. More after 00:00 UTC.' : ''}</span>
        <button type="submit" className="upload-submit" disabled={!ready}>Upload</button>
      </div>
    </form>
  )
}

type StepState = 'done' | 'current' | 'todo' | 'failed'

/** Where the journey stands at each step, from the upload's phase and its job. */
function stepStates(upload: Extract<Upload, { phase: 'sending' | 'server' }>, steps: readonly string[]): StepState[] {
  if (upload.phase === 'sending') return steps.map((s) => (s === 'uploading' ? 'current' : 'todo'))
  const { job } = upload
  if (job.state === 'done') return steps.map(() => 'done')
  const at = job.stage ? steps.indexOf(job.stage) : job.state === 'uploading' ? 0 : steps.indexOf('uploading') + 1
  const here: StepState = job.state === 'failed' ? 'failed' : job.state === 'processing' ? 'current' : 'todo'
  return steps.map((_, i) => (i < at ? 'done' : i === at ? here : 'todo'))
}

function stepCount(upload: Upload, step: string): string | null {
  if (upload.phase === 'sending') {
    if (step !== 'uploading') return null
    return `${formatBytes(upload.sent)} of ${formatBytes(upload.size)}${upload.bytesPerSec ? ` · ${formatBytes(upload.bytesPerSec)}/s` : ''}`
  }
  if (upload.phase !== 'server' || upload.job.stage !== step || upload.job.total <= 1) return null
  return `${upload.job.done.toLocaleString('en-US')} / ${upload.job.total.toLocaleString('en-US')}`
}

function Journey({ upload, onCancel, onAnother, onShowFilm }: { upload: Upload; onCancel: () => void; onAnother: () => void; onShowFilm: (id: FilmId) => void }) {
  if (upload.phase === 'refused') {
    return (
      <div className="journey">
        <p className="journey-title">{upload.title}</p>
        <p className="upload-error" role="alert">{upload.message}</p>
        <div className="upload-foot"><span /><button type="button" className="upload-submit" onClick={onAnother}>Try again</button></div>
      </div>
    )
  }
  const source: Source = upload.phase === 'sending' ? (upload.size ? 'file' : 'url') : upload.job.source
  const job = upload.phase === 'server' ? upload.job : null
  const steps = stepsFor(source)
  const states = stepStates(upload, steps)
  return (
    <div className="journey">
      <div className="journey-head">
        <p className="journey-title">{upload.title}</p>
        <Percent value={upload.progress} />
      </div>
      <Bar value={upload.progress} />
      {job?.state === 'done' ? (
        <div className="journey-done">
          <p className="job-done"><Check />In the archive{job.error && <span className="job-done-note"> · {job.error}</span>}</p>
          <div className="upload-foot">
            <button type="button" className="text-button" onClick={onAnother}>Upload another</button>
            <button type="button" className="upload-submit" onClick={() => onShowFilm(job.filmId)}>View in archive</button>
          </div>
        </div>
      ) : (
        <>
          <ol className="stages">
            {steps.map((step, i) => {
              const st = states[i]!
              const count = st === 'current' ? stepCount(upload, step) : null
              return (
                <li key={step} data-state={st}>
                  <span className="stage-mark" aria-hidden="true">{st === 'current' ? <span className="spinner" /> : st === 'done' ? <Check /> : null}</span>
                  <span className="stage-name">{sentence(step)}</span>
                  {count && <span className="stage-count">{count}</span>}
                </li>
              )
            })}
          </ol>
          {upload.phase === 'sending' && (
            <div className="upload-foot">
              <span className="job-note">{upload.size ? '' : 'Sending the link…'}</span>
              <button type="button" className="text-button journey-cancel" onClick={onCancel}>Cancel</button>
            </div>
          )}
          {job?.state === 'queued' && <p className="job-note">Queued, waiting for a worker</p>}
          {job?.state === 'failed' && (
            <>
              <p className="upload-error" role="alert">{job.error ?? 'Processing failed'}</p>
              <div className="upload-foot"><span /><button type="button" className="upload-submit" onClick={onAnother}>Upload another</button></div>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- my uploads

type Moving = Extract<Upload, { phase: 'sending' | 'server' }>

/** One line of my uploads: something still moving (from this tab's polled list), a film in the archive, or a failure to explain. */
type Row =
  | { kind: 'active'; key: string; upload: Moving }
  | { kind: 'ready'; key: string; job: Job; film: Film }
  | { kind: 'failed'; key: string; job: Job }

const moving = (u: Upload): u is Moving => u.phase !== 'refused'

/**
 * Running uploads first (polled live), then the API's finished jobs newest first. Rows keep the tab's upload key so a
 * job that finishes here changes in place. Cancelled, deleted, dismissed and abandoned jobs are left out.
 */
function rowsFor(list: readonly Upload[], jobs: readonly Job[], films: readonly Film[], hidden: ReadonlySet<string>): Row[] {
  const tabbed = new Map(list.filter(moving).flatMap((u) => (u.phase === 'server' ? [[u.job.id, u] as const] : [])))
  const own = new Map(films.filter((f) => f.ownerIsYou).map((f) => [f.id, f]))
  const active = list.filter((u): u is Moving => uploadActive(u) && moving(u))
  const activeIds = new Set(active.flatMap((u) => (u.phase === 'server' ? [u.job.id] : [])))
  const rest = [...jobs].sort((a, b) => b.created - a.created).flatMap((listed): Row[] => {
    if (activeIds.has(listed.id) || hidden.has(listed.id)) return []
    const fromTab = tabbed.get(listed.id)
    const job = fromTab?.phase === 'server' ? fromTab.job : listed
    const key = fromTab?.key ?? job.id
    if (job.state === 'done') {
      const film = own.get(job.filmId)
      // Finished here, its library refresh still on the way: keep the row where it was.
      return film ? [{ kind: 'ready', key, job, film }] : fromTab ? [{ kind: 'active', key, upload: fromTab }] : []
    }
    return job.state === 'failed' && job.error !== 'cancelled' ? [{ kind: 'failed', key, job }] : []
  })
  return [...active.map((u): Row => ({ kind: 'active', key: u.key, upload: u })), ...rest]
}

const DISMISSED = 'vidsearch.dismissed'

function loadDismissed(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(DISMISSED) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveDismissed(ids: ReadonlySet<string>) {
  try { localStorage.setItem(DISMISSED, JSON.stringify([...ids].slice(-200))) } catch { /* storage blocked: hidden for this visit only */ }
}

const ROW_LEAVE_MS = 220

function MyUploads({ noun, uploads, films, onTab, onLibraryChanged, onShowFilm }: {
  noun: string
  uploads: Uploads
  films: readonly Film[]
  onTab: (tab: Tab) => void
  onLibraryChanged: () => void
  onShowFilm: (id: FilmId) => void
}) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set())
  const [deleted, setDeleted] = useState<ReadonlySet<JobId>>(() => new Set())
  const [dismissed, setDismissed] = useState(loadDismissed)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const shownFirst = useRef<Set<string> | null>(null)
  const { refreshJobs } = uploads
  useEffect(() => { refreshJobs() }, [refreshJobs])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const jobs = uploads.jobs?.jobs
  const rows = jobs ? rowsFor(uploads.list, jobs, films, new Set([...deleted, ...dismissed])) : null
  useEffect(() => { if (rows && !shownFirst.current) shownFirst.current = new Set(rows.map((r) => r.key)) })

  /** Collapse the row, then drop it. */
  const leave = (key: string, then: () => void) => {
    setLeaving((s) => new Set(s).add(key))
    setTimeout(then, reducedMotion() ? 0 : ROW_LEAVE_MS)
  }
  const remove = (row: Extract<Row, { kind: 'ready' }>) => {
    setDeleting(row.key)
    setError(null)
    deleteFilm(row.film.id)
      .then(() => leave(row.key, () => { setDeleted((s) => new Set(s).add(row.job.id)); onLibraryChanged(); refreshJobs() }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => { setDeleting(null); setConfirming(null) })
  }
  const dismiss = (row: Extract<Row, { kind: 'failed' }>) => leave(row.key, () => setDismissed((s) => {
    const next = new Set(s).add(row.job.id)
    saveDismissed(next)
    return next
  }))

  if (!rows) return <p className="job-note mine-loading">Loading…</p>
  if (!rows.length) {
    return (
      <div className="mine-empty">
        <p>Nothing uploaded yet</p>
        <button type="button" className="upload-submit" onClick={() => onTab('upload')}>Upload a {noun}</button>
      </div>
    )
  }
  return (
    <>
      <ul className="mine-list">
        {rows.map((row) => (
          <li
            key={row.key}
            className="row"
            data-kind={row.kind}
            data-film={row.kind === 'active' ? undefined : row.job.filmId}
            data-enter={(shownFirst.current !== null && !shownFirst.current.has(row.key)) || undefined}
            data-leaving={leaving.has(row.key) || undefined}
          >
            <div className="row-clip">
              {row.kind === 'ready' ? (
                <div className="row-inner">
                  <button type="button" className="row-open" onClick={() => onShowFilm(row.film.id)} title="Show in the archive">
                    <Thumb film={row.film} />
                    <span className="row-text">
                      <span className="row-title">{row.job.title}</span>
                      <span className="row-meta">{runtime(row.film.duration)} · {ago(row.job.created, now)}</span>
                    </span>
                  </button>
                  {confirming === row.key ? (
                    <span className="row-confirm">
                      <span>Delete?</span>
                      <button type="button" className="text-button danger confirm-yes" disabled={deleting === row.key} onClick={() => remove(row)}>{deleting === row.key ? 'Deleting…' : 'Yes'}</button>
                      <span aria-hidden="true">·</span>
                      <button type="button" className="text-button confirm-no" onClick={() => setConfirming(null)}>No</button>
                    </span>
                  ) : (
                    <button type="button" className="row-delete" aria-label={`Delete ${row.job.title}`} title="Delete" onClick={() => setConfirming(row.key)}>
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" /></svg>
                    </button>
                  )}
                </div>
              ) : row.kind === 'active' ? (
                <div className="row-inner">
                  <Thumb film={null} />
                  <span className="row-text">
                    <span className="row-title">{row.upload.title}</span>
                    <span className="row-meta">{activeLabel(row.upload)}</span>
                    <Bar value={row.upload.progress} />
                  </span>
                </div>
              ) : (
                <div className="row-inner">
                  <Thumb film={null} />
                  <span className="row-text">
                    <span className="row-title">{row.job.title}</span>
                    <span className="row-meta row-error">{row.job.error ?? 'Processing failed'}</span>
                  </span>
                  <button type="button" className="text-button row-dismiss" onClick={() => dismiss(row)}>Dismiss</button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="upload-error" role="alert">{error}</p>}
    </>
  )
}

function activeLabel(u: Moving): string {
  if (u.phase === 'sending') return u.size ? 'uploading' : 'sending the link'
  if (u.job.state === 'done') return 'adding to the archive'
  return u.job.state === 'processing' && u.job.stage ? u.job.stage : 'queued'
}

/** A still from ~3 s in, over a dark placeholder that shows until it loads (and for jobs with no frames yet). */
function Thumb({ film }: { film: Film | null }) {
  const [loaded, setLoaded] = useState(false)
  const frame = film ? Math.min(film.nFrames - 1, Math.round(3 * film.sampleFps)) : 0
  return (
    <span className="thumb">
      {film && <img src={frameStillUrl(film.id, frame)} alt="" data-loaded={loaded || undefined} onLoad={() => setLoaded(true)} />}
    </span>
  )
}

/** 0:30, 12:05, 1:02:40 */
function runtime(seconds: number): string {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

function ago(created: number, now: number): string {
  const s = Math.max(0, now / 1000 - created)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return d === 1 ? 'yesterday' : `${d} days ago`
}
