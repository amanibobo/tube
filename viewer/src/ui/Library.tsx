import { STATIC } from '../api'
import { useStore } from '../store'
import type { VideoMeta } from '../types'
import { duration, stageText } from '../videos'

export const openFilePicker = () => document.querySelector<HTMLInputElement>('#upload-input')?.click()

function detail(meta: VideoMeta): string {
  if (meta.status === 'ready') return duration(meta.duration_s)
  if (meta.status === 'failed') return 'Failed'
  return `${stageText(meta)} · ${Math.round(meta.progress * 100)}%`
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden className={open ? 'chevron open' : 'chevron'}>
      <path d="M2.5 4l2.5 2.5L7.5 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function Library() {
  const library = useStore((s) => s.library)
  const videoId = useStore((s) => s.videoId)
  const title = useStore((s) => s.meta?.title)
  const open = useStore((s) => s.libraryOpen)
  const { select, toggleLibrary, pickFile } = useStore.getState()

  return (
    <section className="library">
      <div className="library-head">
        <button className="library-current link" aria-expanded={open} onClick={() => toggleLibrary()}>
          <span className="ellipsis">{title ?? 'Videos'}</span>
          <Chevron open={open} />
        </button>
      </div>
      <div className="library-links">
        <a className="link muted small" href="/">
          Home
        </a>
        {STATIC ? (
          <a
            className="link muted small"
            href="https://github.com/amanibobo/tube#run-it"
            target="_blank"
            rel="noreferrer"
            title="Uploads need Tube running locally"
          >
            Run locally
          </a>
        ) : (
          <>
            <button className="link muted small" onClick={openFilePicker}>
              Upload video
            </button>
            <input
              id="upload-input"
              type="file"
              accept="video/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void pickFile(file)
              }}
            />
          </>
        )}
        <a className="link muted small" href={videoId ? `/archive?v=${encodeURIComponent(videoId)}` : '/archive'}>
          Archive search
        </a>
      </div>
      {open && (
        <ul className="library-list fade-in">
          {library.map((meta) => (
            <li key={meta.id}>
              <button className={meta.id === videoId ? 'library-row active' : 'library-row'} onClick={() => select(meta.id)}>
                <span className="ellipsis">{meta.title}</span>
                <span className="muted small nowrap">{detail(meta)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
