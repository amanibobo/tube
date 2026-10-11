import { GrainGradient } from '@paper-design/shaders-react'
import { useEffect, useState } from 'react'
import { DitherCube, type Palette } from './DitherCube'
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
        <p className="lp-blurb">
          Cities have thousands of traffic cameras, and almost nobody watches them. Tube stacks a clip into a cube
          where every car and person becomes a tube through time, so “every time a person and a car got close” turns
          into geometry. Near misses show up before a crash report does.
        </p>
        <nav className="lp-links" aria-label="Links">
          <button
            type="button"
            className="lp-square"
            onClick={() => setTheme(next)}
            aria-label={`Switch to ${next} mode`}
            title={`Switch to ${next} mode`}
          />
          <a href={DEVPOST_URL} className="lp-link lp-devpost" target="_blank" rel="noreferrer">
            <DevpostMark />
            Devpost
          </a>
          <a href={PORTFOLIO_URL} className="lp-link" target="_blank" rel="noreferrer">
            Portfolio
          </a>
          <a href={APP_URL} className="lp-link lp-primary">
            Open the app <span aria-hidden>→</span>
          </a>
        </nav>
      </footer>
    </main>
  )
}
