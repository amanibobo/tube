import { useCallback, useEffect, useRef } from 'react'
import { useVoice, voiceActive, type Ending } from '../archive/voice'
import { useStore } from '../store'

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="7" cy="7" r="4.75" />
      <path d="M10.5 10.5L14 14" strokeLinecap="round" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <rect x="5.5" y="1.75" width="5" height="8" rx="2.5" />
      <path d="M3.25 7.75a4.75 4.75 0 0 0 9.5 0M8 12.5v1.75" />
    </svg>
  )
}

/** Search by typing or by voice. Voice uses the archive's realtime speech-to-text, so a spoken query runs like a typed one. */
export function SearchPill() {
  const input = useStore((s) => s.input)
  const loading = useStore((s) => s.search.kind === 'loading')
  const { type, ask, clear } = useStore.getState()
  const field = useRef<HTMLInputElement>(null)
  const mic = useRef<HTMLButtonElement>(null)

  const onHeard = useCallback(
    (heard: string, ending: Ending) => {
      if (heard) {
        type(heard)
        if (ending === 'auto') void ask(heard)
      }
      requestAnimationFrame(() => field.current?.focus())
    },
    [type, ask],
  )
  const voice = useVoice(mic, onHeard)
  const active = voiceActive(voice.state)
  const { stop } = voice

  // Esc stops listening without also clearing the search (the app's own Esc handler runs later, on bubble).
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      stop()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, stop])

  const heard = voice.state.kind === 'listening' || voice.state.kind === 'finishing' ? voice.state : null
  const hint =
    voice.state.kind === 'requesting' ? 'Allow the microphone…' : voice.state.kind === 'connecting' ? 'Connecting…' : 'Listening…'

  return (
    <form
      className="pill"
      onSubmit={(e) => {
        e.preventDefault()
        if (active) stop()
        else if (input.trim()) void ask(input.trim())
      }}
    >
      <span className="pill-icon">{loading || voice.state.kind === 'finishing' ? <span className="spinner" /> : <SearchIcon />}</span>
      <div className="pill-field">
        <input
          ref={field}
          className={active ? 'hearing' : undefined}
          value={input}
          placeholder="Search cars, people, or ask a question"
          spellCheck={false}
          onChange={(e) => {
            voice.cancel()
            voice.dismiss()
            type(e.target.value)
          }}
          aria-label="Search"
        />
        {active && (
          <div className="pill-transcript" aria-live="polite">
            {heard && (heard.committed || heard.partial) ? (
              <span>
                {heard.committed}
                {heard.committed && heard.partial ? ' ' : ''}
                <span className="muted">{heard.partial}</span>
              </span>
            ) : (
              <span className="muted">{hint}</span>
            )}
          </div>
        )}
      </div>
      {voice.state.kind === 'error' && (
        <span className="pill-error" title={voice.state.detail}>
          {voice.state.message}
        </span>
      )}
      {input && !active && (
        <button type="button" className="pill-clear" onClick={clear} aria-label="Clear">
          ×
        </button>
      )}
      <button
        type="button"
        ref={mic}
        className={`pill-mic ${voice.state.kind}`}
        aria-label={active ? 'Stop listening' : 'Search by voice'}
        aria-pressed={active}
        title={active ? 'Stop listening (Esc)' : 'Search by voice'}
        onClick={() => (active ? stop() : voice.start())}
      >
        <MicIcon />
      </button>
    </form>
  )
}
