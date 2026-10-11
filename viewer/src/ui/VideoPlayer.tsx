import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { playback } from '../playback'
import { useStore } from '../store'
import { clock } from '../time'
import type { Video, VideoId } from '../types'

type Seekable = HTMLVideoElement & { fastSeek?: (time: number) => void }

const SPEEDS = [1, 2, 4, 8] as const

function useSceneSeeks(ref: React.RefObject<Seekable | null>, fps: number) {
  const pending = useRef<number | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const seek = (frame: number, precise: boolean) => {
      const time = frame / fps
      if (!precise && el.fastSeek) el.fastSeek(time)
      else el.currentTime = time
    }
    const onSeeked = () => {
      if (pending.current === null) return
      const frame = pending.current
      pending.current = null
      seek(frame, !useStore.getState().scrubbing)
    }
    el.addEventListener('seeked', onSeeked)

    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.frameSource === 'video') return
      if (s.frame !== prev.frame && !el.paused) el.pause()
      if (s.frameSource !== 'scene') return
      const landed = s.frame !== prev.frame || prev.frameSource !== 'scene' || s.scrubbing !== prev.scrubbing
      if (!landed || Math.round(el.currentTime * fps) === s.frame) return
      if (el.seeking) pending.current = s.frame
      else seek(s.frame, !s.scrubbing)
    })
    return () => {
      unsubscribe()
      el.removeEventListener('seeked', onSeeked)
    }
  }, [ref, fps])
}

function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden>
      {playing ? (
        <>
          <rect x="1" y="1" width="2.6" height="10" rx="0.6" />
          <rect x="6.4" y="1" width="2.6" height="10" rx="0.6" />
        </>
      ) : (
        <path d="M1.5 1.2v9.6c0 .4.4.6.7.4l7.4-4.8c.3-.2.3-.6 0-.8L2.2.8c-.3-.2-.7 0-.7.4z" />
      )}
    </svg>
  )
}

export function VideoPlayer({ id, video }: { id: VideoId; video: Video }) {
  const ref = useRef<Seekable>(null)
  const frame = useStore((s) => s.frame)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<number>(1)
  useSceneSeeks(ref, video.fps)

  useEffect(() => {
    const el = ref.current
    if (el) el.playbackRate = el.defaultPlaybackRate = speed
  }, [speed])

  useEffect(() => {
    const el = ref.current
    if (!el || !playing) return
    let id = 0
    const tick: VideoFrameRequestCallback = (_, meta) => {
      useStore.getState().setFrame(Math.round(meta.mediaTime * video.fps), 'video')
      id = el.requestVideoFrameCallback(tick)
    }
    id = el.requestVideoFrameCallback(tick)
    return () => el.cancelVideoFrameCallback(id)
  }, [playing, video.fps])

  const toggle = () => {
    const el = ref.current
    if (el) void (el.paused ? el.play() : el.pause())
  }

  useEffect(() => {
    playback.toggle = toggle
  })

  return (
    <div className="player">
      <video
        ref={ref}
        src={api.videoUrl(id)}
        muted
        playsInline
        preload="auto"
        poster={api.frameUrl(id, 0)}
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => (e.currentTarget.playbackRate = speed)}
        style={{ aspectRatio: `${video.width} / ${video.height}` }}
      />
      <div className="player-bar">
        <button className="icon-button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          <PlayIcon playing={playing} />
        </button>
        <span className="time">
          {clock(frame, video.fps)} <span className="muted">/ {clock(video.frames, video.fps)}</span>
        </span>
        <div className="speeds" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={s === speed ? 'speed active' : 'speed'}
              aria-pressed={s === speed}
              onClick={() => setSpeed(s)}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
