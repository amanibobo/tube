import type { Film, Identity } from './api'

/** `8 clips · 2 h 46 min · 9,951 frames`: item count, total running time, total sampled frames. */
export function archiveStats(films: readonly Film[], identity: Identity): string {
  const minutes = Math.round(films.reduce((s, f) => s + f.duration, 0) / 60)
  const h = Math.floor(minutes / 60), m = minutes % 60
  const runtime = h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`
  const frames = films.reduce((n, f) => n + f.nFrames, 0).toLocaleString('en-US')
  return `${films.length} ${films.length === 1 ? identity.noun : identity.nounPlural} · ${runtime} · ${frames} frames`
}

/** Tube's cube, on the video it showed before Archive search was opened (Tube passes it along as `?v=`). */
function cubeHref(): string {
  const v = new URLSearchParams(location.search).get('v')
  return v ? `/app?v=${encodeURIComponent(v)}` : '/app'
}

export function Masthead({ identity, films }: { identity: Identity; films: readonly Film[] | null }) {
  return (
    <header className="masthead">
      <h1 className="masthead-title">{identity.title}</h1>
      {films && <p className="masthead-stats">{archiveStats(films, identity)}</p>}
      <a className="masthead-back" href={cubeHref()}>
        Back to the cube
      </a>
    </header>
  )
}
