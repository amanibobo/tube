import { useStore } from '../store'

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="7" cy="7" r="4.75" />
      <path d="M10.5 10.5L14 14" strokeLinecap="round" />
    </svg>
  )
}

export function SearchPill() {
  const input = useStore((s) => s.input)
  const loading = useStore((s) => s.search.kind === 'loading')
  const { type, ask, clear } = useStore.getState()

  return (
    <form
      className="pill"
      onSubmit={(e) => {
        e.preventDefault()
        if (input.trim()) void ask(input.trim())
      }}
    >
      <span className="pill-icon">{loading ? <span className="spinner" /> : <SearchIcon />}</span>
      <input
        value={input}
        placeholder="Search cars, people, or ask a question"
        spellCheck={false}
        onChange={(e) => type(e.target.value)}
        aria-label="Search"
      />
      {input && (
        <button type="button" className="pill-clear" onClick={clear} aria-label="Clear">
          ×
        </button>
      )}
    </form>
  )
}
