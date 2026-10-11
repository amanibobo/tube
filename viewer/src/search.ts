import { singulars } from './classes'
import { HIGHLIGHT_RED } from './scene/space'
import type { Answer, NearMiss, Segment, Tubes } from './types'

export type Search =
  | { kind: 'idle' }
  | { kind: 'classes'; text: string }
  | { kind: 'loading'; text: string }
  | { kind: 'answer'; text: string; answer: Answer }
  | { kind: 'error'; text: string; message: string }

export type Highlight = { matched: Set<number> | null; segments: Segment[] }

const ALIASES: Record<string, string[]> = {
  people: ['person'],
  pedestrian: ['person'],
  ped: ['person'],
  walker: ['person'],
  bike: ['bicycle'],
  cyclist: ['bicycle'],
  vehicle: ['car', 'truck', 'bus', 'motorcycle'],
  motorbike: ['motorcycle'],
}

export const isClassSearch = (text: string) => words(text).length <= 2

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z]+/).filter(Boolean)
}

/** Classes the words name, among the ones this video has or expects (`expected`: what it was asked to track). */
export function matchClasses(text: string, tubes: Tubes, expected: readonly string[]): string[] {
  const known = new Set([...expected, ...tubes.tracks.flatMap((t) => [t.class, t.source_class ?? t.class])])
  return parseClasses(text, known)
}

export function matchingTracks(tubes: Tubes, classes: string[]): number[] {
  const wanted = new Set(classes)
  return tubes.tracks.filter((t) => wanted.has(t.class) || wanted.has(t.source_class ?? '')).map((t) => t.id)
}

function parseClasses(text: string, known: Set<string>): string[] {
  const out = new Set<string>()
  for (const word of words(text)) {
    for (const form of singulars(word)) {
      for (const cls of ALIASES[form] ?? [form]) if (known.has(cls)) out.add(cls)
    }
  }
  return [...out]
}

export function deriveHighlight(search: Search, focus: NearMiss | null, tubes: Tubes, expected: readonly string[]): Highlight {
  if (search.kind === 'classes') {
    const classes = matchClasses(search.text, tubes, expected)
    if (classes.length > 0) return { matched: new Set(matchingTracks(tubes, classes)), segments: [] }
  }
  if (search.kind === 'answer') return fromSegments(search.answer.highlight.segments)
  if (focus) {
    const half = Math.round(tubes.video.fps / 2)
    return fromSegments(
      [focus.a, focus.b].map((id) => ({ track_id: id, f_start: focus.f - half, f_end: focus.f + half, color: HIGHLIGHT_RED })),
    )
  }
  return { matched: null, segments: [] }
}

function fromSegments(segments: Segment[]): Highlight {
  return { matched: new Set(segments.map((s) => s.track_id)), segments }
}
