import { useEffect, useState } from 'react'
import { atlasPageCount, type Library } from './api'

/** Milliseconds since `since`, re-rendering a few times a second; 0 while `since` is null. */
export function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [since])
  return since === null ? 0 : Math.max(0, now - since)
}

const WAKE_LINES: readonly (readonly [afterMs: number, line: string])[] = [
  [0, 'Loading the archive'],
  [3000, 'Waking up the server'],
  [10000, 'Still starting. The first visit after a while takes up to half a minute.'],
]

const wakeLine = (elapsedMs: number) => WAKE_LINES.filter(([after]) => elapsedMs >= after).at(-1)![1]

function pagesOf(library: Library): { loaded: number; total: number } | null {
  if (library.status === 'frames') return { loaded: library.settled.size, total: atlasPageCount(library.films) }
  if (library.status === 'ready') {
    const total = atlasPageCount(library.films)
    return { loaded: total, total }
  }
  return null
}

/** Centred over the empty canvas until the strips can show; fades out, then unmounts, once the library is ready. */
export function Loader({ library, onRetry }: { library: Library; onRetry: () => void }) {
  const elapsed = useElapsed(library.status === 'waking' ? library.since : null)
  const [gone, setGone] = useState(false)
  if (gone) return null
  const done = library.status === 'ready'
  const pages = pagesOf(library)
  return (
    <div className={done ? 'loader done' : 'loader'} role="status" onTransitionEnd={(e) => { if (done && e.target === e.currentTarget) setGone(true) }}>
      {library.status === 'error' ? (
        <>
          <p className="loader-line">The archive did not answer</p>
          <p className="loader-detail" title={library.message}>{library.message}</p>
          <button type="button" className="loader-retry" onClick={onRetry}>Retry</button>
        </>
      ) : (
        <>
          <div className="loader-strips" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <span key={i} />)}</div>
          <p className="loader-line">{pages ? `Loading frames ${pages.loaded} / ${pages.total}` : wakeLine(elapsed)}</p>
          <div className={pages ? 'loader-progress' : 'loader-progress waiting'} aria-hidden="true">
            <span style={pages ? { transform: `scaleX(${pages.loaded / Math.max(1, pages.total)})` } : undefined} />
          </div>
        </>
      )}
    </div>
  )
}
