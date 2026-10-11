import type { Trackable, Tubes, VideoMeta } from './types'

/** The traffic default, as tubes.json labels it; also what search expects before a traffic clip's tracks arrive. */
const TRAFFIC = ['car', 'person', 'bicycle', 'truck', 'bus', 'motorcycle']
const VEHICLES = new Set(['car', 'truck', 'bus', 'motorcycle'])

export const DEFAULT_TRACK_TEXT = 'cars, people, bikes'

/** Names worth suggesting beside the default, when the detector can track them. */
const SUGGESTED = ['dog', 'cat', 'horse', 'bird', 'player', 'ball']

const orList = (items: string[]) => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`)

const IRREGULAR: Record<string, string> = { people: 'person', person: 'people', mice: 'mouse', geese: 'goose', children: 'child' }

export const isTraffic = (meta: VideoMeta | null) => !meta?.track?.length

/** The classes a video should have: what its upload asked to track, else the traffic default. */
export function videoClasses(meta: VideoMeta | null): string[] {
  return meta?.track?.length ? meta.track.map((t) => t.name) : TRAFFIC
}

/** Every form a typed word could be the plural of: `dogs` → dog, `buses` → bus, `butterflies` → butterfly. */
export function singulars(word: string): string[] {
  const forms = [word, word.replace(/s$/, ''), word.replace(/es$/, ''), word.replace(/ies$/, 'y')]
  if (IRREGULAR[word]) forms.push(IRREGULAR[word])
  return [...new Set(forms.filter(Boolean))]
}

export function plural(name: string): string {
  if (name === 'person') return 'people'
  if (name === 'bicycle') return 'bikes'
  if (/(s|x|ch|sh)$/.test(name)) return `${name}es`
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`
  return `${name}s`
}

export function searchPlaceholder(meta: VideoMeta | null): string {
  if (isTraffic(meta)) return 'Search cars, people, or ask a question'
  return `Search ${videoClasses(meta).map(plural).join(', ')}, or ask a question`
}

const TRAFFIC_QUESTIONS = [
  'Every time a person and a car got close',
  'Top 3 most dangerous moments',
  'Which cars stopped in the crosswalk',
  'Fastest car in the clip',
]

/** Questions the agent can answer for this clip: the traffic set, or ones built from the clip's own classes. */
export function suggestedQuestions(meta: VideoMeta | null): string[] {
  if (isTraffic(meta)) return TRAFFIC_QUESTIONS
  const [first] = videoClasses(meta)
  if (!first) return []
  return [`When did two ${plural(first)} get closest`, `Which ${first} moved the most`, `Fastest ${first} in the clip`]
}

/** Closest calls are person-vehicle near misses, so they only mean something for clips with both. */
export function hasPeopleAndVehicles(tubes: Tubes): boolean {
  const classes = new Set(tubes.tracks.flatMap((t) => [t.class, t.source_class ?? t.class]))
  return classes.has('person') && [...VEHICLES].some((v) => classes.has(v))
}

export function suggestedNames(trackable: Trackable | null): string[] {
  if (!trackable) return []
  const known = new Set([...trackable.names, ...Object.keys(trackable.aliases)])
  return SUGGESTED.filter((n) => known.has(n))
}

export type TrackChoice = { ok: true; track: string | null } | { ok: false; message: string }

/**
 * What to send as `track`: null for the traffic default (left as is, or emptied), else the typed names. Names the
 * detector can't resolve are refused here with a sentence; the server checks again and its 400 says why.
 */
export function chooseTrack(text: string, trackable: Trackable | null): TrackChoice {
  const names = text
    .toLowerCase()
    .split(/,|\band\b/)
    .map((n) => n.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
  if (names.length === 0 || names.join(', ') === DEFAULT_TRACK_TEXT) return { ok: true, track: null }
  if (!trackable) return { ok: true, track: names.join(', ') }
  const known = new Set([...trackable.names, ...Object.keys(trackable.aliases)])
  const unknown = names.filter((n) => !singulars(n).some((form) => known.has(form)))
  if (unknown.length === 0) return { ok: true, track: names.join(', ') }
  const examples = suggestedNames(trackable)
  const tryThese = examples.length ? ` Try ${orList(examples)}.` : ''
  return { ok: false, message: `Tube can’t track ${orList(unknown.map((n) => `“${n}”`))} yet.${tryThese}` }
}
