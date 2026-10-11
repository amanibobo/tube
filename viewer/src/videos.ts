import type { Stage, VideoMeta } from './types'

const STAGE_WORDS: Record<Stage, string> = {
  normalizing: 'Preparing video',
  segmenting: 'Finding cars and people',
  building: 'Building tubes',
  indexing: 'Indexing',
}

const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v|webm|mkv|avi)$/i

export const isVideoFile = (file: File) => file.type.startsWith('video/') || VIDEO_EXTENSIONS.test(file.name)

export const titleFromFile = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Untitled video'

export function hasTubes({ status, stage }: Pick<VideoMeta, 'status' | 'stage'>): boolean {
  return status === 'ready' || (status === 'processing' && stage !== null && stage !== 'normalizing')
}

export function stageText(meta: Pick<VideoMeta, 'status' | 'stage'>): string {
  if (meta.status === 'queued') return 'Waiting to start'
  return meta.stage ? STAGE_WORDS[meta.stage] : 'Starting'
}

export function duration(seconds: number | null): string {
  if (seconds === null) return ''
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`
}
