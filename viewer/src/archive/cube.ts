import type { Film } from './api'

/** The hosted demo has no Tube server to cut clips, so the archive can only point at the cube there. */
export const CUBE_AVAILABLE = import.meta.env.VITE_STATIC !== '1'

const REACH_S = 20

export interface ClipWindow { start: number; end: number }

/** 20 s either side of `t`, kept inside the film; tenths, so the same moment asks for the same clip (Tube's route is idempotent). */
export function clipWindow(t: number, duration: number): ClipWindow {
  const tenths = (s: number) => Math.round(s * 10) / 10
  return { start: tenths(Math.max(0, t - REACH_S)), end: tenths(Math.min(duration, t + REACH_S)) }
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export const clipTitle = (film: Film, w: ClipWindow) => `${film.title} · ${mmss(w.start)}–${mmss(w.end)}`

export type CubeResult = { ok: true; id: string } | { ok: false; message: string }

/** Tube's `POST /api/videos/clip` on this origin (not the archive API): it cuts the window from the film's video and runs the cube's job. */
export async function sendToCube(film: Film, w: ClipWindow): Promise<CubeResult> {
  let res: Response
  try {
    res = await fetch('/api/videos/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: film.videoUrl, start_s: w.start, end_s: w.end, title: clipTitle(film, w) }),
    })
  } catch {
    return { ok: false, message: 'Tube’s server did not answer.' }
  }
  const body: unknown = await res.json().catch(() => null)
  const field = (k: string) => (typeof body === 'object' && body !== null && k in body ? (body as Record<string, unknown>)[k] : undefined)
  const id = field('id')
  if (res.ok && typeof id === 'string') return { ok: true, id }
  const error = field('error')
  return { ok: false, message: typeof error === 'string' ? error : `Tube could not cut this clip (HTTP ${res.status}).` }
}
