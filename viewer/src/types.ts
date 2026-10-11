export type Px = [number, number]

export type Video = {
  id: string
  fps: number
  width: number
  height: number
  frames: number
  thumb_stride: number
  thumb_width: number
}

export type TrackFrame = {
  f: number
  bbox: [number, number, number, number]
  centroid: Px
  contour: Px[]
}

export type Track = {
  id: number
  class: string
  source_class?: string
  first_frame: number
  last_frame: number
  frames: TrackFrame[]
}

export type Tubes = { video: Video; tracks: Track[] }

export type VideoId = string & { readonly brand: 'VideoId' }

export type Stage = 'normalizing' | 'segmenting' | 'building' | 'indexing'

export type VideoMeta = {
  id: VideoId
  title: string
  status: 'queued' | 'processing' | 'ready' | 'failed'
  stage: Stage | null
  progress: number
  error: string | null
  duration_s: number | null
  notice?: string | null
  /** What the upload asked to track, as resolved by the server; absent for the traffic default. */
  track?: TrackedName[] | null
}

/** A name the user typed (`player`) and the detector class it resolved to (`person`). */
export type TrackedName = { name: string; detector: string }

/** `GET /api/trackable`: what the local detector can track. */
export type Trackable = { default: string[]; names: string[]; aliases: Record<string, string> }

export type JobEvent =
  | { type: 'status'; status: VideoMeta['status']; stage: Stage | null; progress: number }
  | { type: 'tubes'; frames_done: number; tracks: number }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type Segment = { track_id: number; f_start: number; f_end: number; color: string }

export type ListItem = { label: string; f: number; score: number }

export type NearMiss = ListItem & { a: number; b: number; min_dist: number }

export type Answer = {
  summary: string
  highlight: { segments: Segment[]; list: ListItem[]; caption: string }
  cached?: boolean
}

export type QueryResponse = Answer | { error: string }
