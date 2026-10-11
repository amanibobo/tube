import { GrainGradient } from '@paper-design/shaders-react'
import { useEffect, useRef, useState } from 'react'
import { DitherCube, type Palette } from './DitherCube'
import '../base.css'
import './landing.css'

type Theme = 'light' | 'dark'

/** The app's tube palette (yellow-green, pink, cyan, mint, lavender, peach, then answer red), deepened on paper. */
const PAPER: Record<
  Theme,
  { back: string; grain: [string, string, string]; ink: [number, number, number]; palette: Palette }
> = {
  light: {
    back: '#f3f1ea',
    grain: ['#ece9e0', '#f7f5ef', '#e9e6dd'],
    ink: [38, 32, 24],
    palette: ['#86a312', '#dc4f93', '#139fb8', '#22a06b', '#7559d6', '#d9801c', '#e5372b'],
  },
  dark: {
    back: '#0b0b0b',
    grain: ['#121212', '#0e0e0e', '#161616'],
    ink: [236, 234, 228],
    palette: ['#dcf26a', '#ff9ed2', '#6ef0ff', '#8ff5c2', '#c6b3ff', '#ffc98a', '#ff3b30'],
  },
}

const APP_URL = '/app'
const PORTFOLIO_URL = 'https://amanibobo.dev'
/** Placeholder until the Devpost submission is live; swap in the real project URL. */
const DEVPOST_URL = 'https://devpost.com/software/tube'
const DEEPWIKI_URL = 'https://deepwiki.com/amanibobo/tube'
const HACKLANTA_URL = 'https://hacklanta.dev'
/** Set to the demo recording's URL once it exists; until then the dialog shows a still of the app. */
const DEMO_SRC: string | null = null
const DEMO_POSTER = '/demo-poster.jpg'

/** The demo in a dialog over the page. Until DEMO_SRC is set it shows a still of the app. */
function DemoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="lp-dialog"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-label="Demo video"
    >
      <div className="lp-player">
        {open && DEMO_SRC ? (
          <video src={DEMO_SRC} poster={DEMO_POSTER} controls autoPlay playsInline />
        ) : (
          <img src={DEMO_POSTER} alt="Tube showing a junction clip with every car's tube lit" />
        )}
      </div>
      <div className="lp-dialog-bar">
        <span className="lp-muted">{DEMO_SRC ? 'Tube demo' : 'Demo video coming soon'}</span>
        <button type="button" className="lp-close" onClick={onClose} aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </dialog>
  )
}

/** The Devpost mark, drawn small and monochrome: a hexagon around a D. */
function DevpostMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path d="M6 2.5h12L23.5 12 18 21.5H6L.5 12z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path
        d="M8.5 7h3.6c2.9 0 4.9 2 4.9 5s-2 5-4.9 5H8.5zm2.3 2.1v5.8h1.2c1.6 0 2.7-1.1 2.7-2.9s-1.1-2.9-2.7-2.9z"
        fill="currentColor"
      />
    </svg>
  )
}

function storedTheme(): Theme {
  try {
    return localStorage.getItem('tubewatch-theme') === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** The landing: four corners of small type and one dashed space-time cube. Clicking the cube opens the app. */
export function Landing() {
  const [theme, setTheme] = useState<Theme>(storedTheme)
  const [demo, setDemo] = useState(false)
  const next: Theme = theme === 'dark' ? 'light' : 'dark'
  const colors = PAPER[theme]

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try {
      localStorage.setItem('tubewatch-theme', theme)
    } catch {
      // private windows can refuse storage; the theme just won't persist
    }
  }, [theme])

  return (
    <main className="lp" data-theme={theme}>
      <div className="lp-grain" aria-hidden>
        <GrainGradient
          style={{ width: '100%', height: '100%' }}
          colorBack={colors.back}
          colors={colors.grain}
          softness={0.85}
          intensity={0.18}
          noise={0.55}
          speed={0.25}
          shape="wave"
          scale={1.4}
        />
      </div>

      <header className="lp-head">
        <div className="lp-title">
          <span className="lp-name">Tube</span>
          <span className="lp-muted">Space-time search for traffic video</span>
        </div>
      </header>

      <section className="lp-stage">
        <a className="lp-cube" href={APP_URL} aria-label="Open the app">
          <DitherCube ink={colors.ink} palette={colors.palette} />
        </a>
      </section>

      <footer className="lp-corners">
        <div className="lp-about">
          <a href={HACKLANTA_URL} className="lp-built" target="_blank" rel="noreferrer">
            <span>Built for</span>
            <img src="/hacklanta.png" width={36} height={28} alt="Hacklanta '26" />
          </a>
          <p className="lp-blurb">
            Cities have thousands of traffic cameras, and almost nobody watches them. Tube stacks a clip into a cube
            where every car and person becomes a tube through time, so “every time a person and a car got close” turns
            into geometry. Near misses show up before a crash report does.
          </p>
        </div>
        <nav className="lp-links" aria-label="Links">
          <button
            type="button"
            className="lp-square"
            onClick={() => setTheme(next)}
            aria-label={`Switch to ${next} mode`}
            title={`Switch to ${next} mode`}
          />
          <a href={DEVPOST_URL} className="lp-link lp-iconlink" target="_blank" rel="noreferrer">
            <DevpostMark />
            Devpost
          </a>
          <a href={DEEPWIKI_URL} className="lp-link lp-iconlink" target="_blank" rel="noreferrer">
            <img className="lp-deepwiki" src="https://deepwiki.com/favicon.ico" width={14} height={14} alt="" />
            DeepWiki
          </a>
          <a href={PORTFOLIO_URL} className="lp-link" target="_blank" rel="noreferrer">
            Portfolio
          </a>
          <button type="button" className="lp-link lp-iconlink lp-button" onClick={() => setDemo(true)}>
            <svg width="9" height="11" viewBox="0 0 10 12" aria-hidden>
              <path d="M1.5 1.2v9.6c0 .4.4.6.7.4l7.4-4.8c.3-.2.3-.6 0-.8L2.2.8c-.3-.2-.7 0-.7.4z" fill="currentColor" />
            </svg>
            Demo video
          </button>
          <a href={APP_URL} className="lp-link lp-primary">
            Open the app <span aria-hidden>→</span>
          </a>
        </nav>
      </footer>
      <DemoDialog open={demo} onClose={() => setDemo(false)} />
    </main>
  )
}
