import { useStore } from '../store'
import { megabytes, stageText } from '../videos'
import { openFilePicker } from './Library'
import { TrackStep } from './TrackStep'

function Progress({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ transform: `scaleX(${Math.min(1, Math.max(0, value))})` }} />
    </div>
  )
}

export function JobStatus() {
  const upload = useStore((s) => s.upload)
  const meta = useStore((s) => s.meta)
  const notice = useStore((s) => (s.notice && s.notice.id === s.videoId ? s.notice.text : null))
  const tracks = useStore((s) => s.tubes?.tracks.length ?? null)
  const working = meta && (meta.status === 'queued' || meta.status === 'processing')

  return (
    <>
      {upload.kind === 'choosing' && <TrackStep upload={upload} />}
      {upload.kind === 'sending' && (
        <div className="job">
          <div className="job-line">
            <span className="ellipsis">Uploading {upload.name}</span>
            <span className="muted small nowrap">
              {megabytes(upload.loaded)} of {megabytes(upload.total)}
            </span>
          </div>
          <Progress value={upload.total ? upload.loaded / upload.total : 0} />
        </div>
      )}
      {upload.kind === 'rejected' && <p className="job muted">{upload.message}</p>}
      {working && (
        <div className="job">
          <div className="job-line">
            <span>{stageText(meta)}</span>
            <span className="muted small">{Math.round(meta.progress * 100)}%</span>
          </div>
          <Progress value={meta.progress} />
          {tracks !== null && meta.stage !== 'normalizing' && (
            <p className="muted small">{tracks === 1 ? '1 track so far' : `${tracks} tracks so far`}</p>
          )}
        </div>
      )}
      {meta?.status === 'failed' && (
        <div className="job">
          <p className="muted">{meta.error ?? 'This video could not be processed.'}</p>
          <button className="button" onClick={openFilePicker}>
            Upload again
          </button>
        </div>
      )}
      {notice && <p className="muted small">{notice}</p>}
    </>
  )
}
