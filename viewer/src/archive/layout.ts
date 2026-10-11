import type { Film, FilmId } from './api'

const COLUMN_W = 1
const COLUMN_GAP = 0.3
const FILM_GAP = 0.95
/** Plane depth per frame: each thumbnail squashed to a thin slice, ~6x flatter than its natural aspect. */
const SLICE_H = 0.12
/** Target width/length of the whole plane, so 3 films and 30 read as the same wide field of strips. */
const PLANE_ASPECT = 1.2
/** Each slice shows this centred band of its thumbnail's height, so neighbouring frames read as continuous streaks. */
const SLICE_BAND = 0.36
const MIN_COLUMN_FRAMES = 60
const CARD_W = 2.6

export interface PageLayout { page: number; url: string; first: number; count: number }

/** Frames [first, first + count) of one film, laid along +y from y = 0 at x. */
export interface Column { x: number; first: number; count: number }

export interface StripLayout {
  film: Film
  columns: Column[]
  perColumn: number
  /** Plane quad per frame; h is also the pitch along y; band is the fraction of the thumbnail's height it shows. */
  slice: { w: number; h: number; band: number }
  /** Full-aspect card a search result lifts into. */
  card: { w: number; h: number }
  pages: PageLayout[]
}

export interface LibraryLayout { strips: StripLayout[]; width: number; length: number }

export function layoutLibrary(films: readonly Film[]): LibraryLayout {
  const total = films.reduce((n, f) => n + f.nFrames, 0)
  const pitch = COLUMN_W + COLUMN_GAP
  // Solve columns * pitch = PLANE_ASPECT * columnFrames * SLICE_H with columns ~ total / columnFrames.
  const target = Math.max(MIN_COLUMN_FRAMES, Math.sqrt((total * pitch) / (PLANE_ASPECT * SLICE_H)))
  let x = COLUMN_W / 2
  let length = 0
  const strips = films.map((film) => {
    const k = Math.max(1, Math.round(film.nFrames / target))
    const perColumn = Math.ceil(film.nFrames / k)
    const columns: Column[] = []
    for (let first = 0; first < film.nFrames; first += perColumn) {
      columns.push({ x, first, count: Math.min(perColumn, film.nFrames - first) })
      x += pitch
    }
    x += FILM_GAP - COLUMN_GAP
    length = Math.max(length, perColumn * SLICE_H)
    const { cellW, cellH, perPage, urls } = film.atlas
    return {
      film,
      columns,
      perColumn,
      slice: { w: COLUMN_W, h: SLICE_H, band: SLICE_BAND },
      card: { w: CARD_W, h: (CARD_W * cellH) / cellW },
      pages: urls.map((url, page) => {
        const first = page * perPage
        return { page, url, first, count: Math.max(0, Math.min(perPage, film.nFrames - first)) }
      }),
    }
  })
  return { strips, width: Math.max(0, x - FILM_GAP - COLUMN_W / 2), length }
}

/** Centre of a frame's slice on the plane (z = 0). Frame 0 sits at the near edge; time runs away along +y. */
export function framePosition(strip: StripLayout, frame: number): [number, number] {
  const c = Math.min(strip.columns.length - 1, Math.floor(frame / strip.perColumn))
  const column = strip.columns[c]!
  return [column.x, (frame - column.first + 0.5) * strip.slice.h]
}

export function stripOf(layout: LibraryLayout, filmId: FilmId): StripLayout | undefined {
  return layout.strips.find((s) => s.film.id === filmId)
}

/** Bottom-left UV and UV size of a frame's cell, from the page texture's real pixel size (pages are not square). */
export function atlasUv(film: Film, frame: number, image: { width: number; height: number }): { u: number; v: number; du: number; dv: number } {
  const { cellW, cellH, cols, perPage } = film.atlas
  const k = frame % perPage
  const du = cellW / image.width
  const dv = cellH / image.height
  return { u: (k % cols) * du, v: 1 - (Math.floor(k / cols) + 1) * dv, du, dv }
}

export function pageOf(strip: StripLayout, frame: number): PageLayout | undefined {
  return strip.pages[Math.floor(frame / strip.film.atlas.perPage)]
}
