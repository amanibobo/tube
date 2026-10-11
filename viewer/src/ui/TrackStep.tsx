import { suggestedNames } from '../classes'
import { useStore, type Upload } from '../store'
import { megabytes } from '../videos'

export function TrackStep({ upload }: { upload: Extract<Upload, { kind: 'choosing' }> }) {
  const trackable = useStore((s) => s.trackable)
  const { editTrack, startUpload, cancelUpload } = useStore.getState()

  return (
    <form
      className="job track-step"
      onSubmit={(e) => {
        e.preventDefault()
        void startUpload()
      }}
    >
      <div className="job-line">
        <span className="ellipsis">{upload.file.name}</span>
        <span className="muted small nowrap">{megabytes(upload.file.size)}</span>
      </div>
      <label className="track-label" htmlFor="track-field">
        What should Tube track?
      </label>
      <input
        id="track-field"
        className="field"
        autoFocus
        value={upload.text}
        spellCheck={false}
        onChange={(e) => editTrack(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.stopPropagation()
          cancelUpload()
        }}
      />
      {suggestedNames(trackable).length > 0 && (
        <div className="track-chips">
          {suggestedNames(trackable).map((name) => (
            <button key={name} type="button" className="chip" onClick={() => editTrack(name)}>
              {name}
            </button>
          ))}
        </div>
      )}
      {upload.error && (
        <p className="track-error" role="alert">
          {upload.error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="button">
          Start
        </button>
        <button type="button" className="link muted small" onClick={cancelUpload}>
          Cancel
        </button>
      </div>
    </form>
  )
}
