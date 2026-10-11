import { matchClasses, matchingTracks, type Search } from '../search'
import { useStore } from '../store'
import { clock } from '../time'
import type { ListItem, NearMiss, Tubes } from '../types'

const SUGGESTIONS = [
  'Every time a person and a car got close',
  'Top 3 most dangerous moments',
  'Which cars stopped in the crosswalk',
  'Fastest car in the clip',
]

type Row = { main: string; detail: string; f: number }

function splitLabel(label: string): [string, string] {
  const [head = '', ...rest] = label.split(', ')
  return [head.replace(/ and /g, ' · '), rest.join(', ')]
}

const fromItem = (item: ListItem): Row => {
  const [main, detail] = splitLabel(item.label)
  return { main, detail, f: item.f }
}

const fromNearMiss = (item: NearMiss): Row => ({ ...fromItem(item), detail: `${Math.round(item.min_dist)} px apart` })

function Rows({ rows, fps, active, onPick }: { rows: Row[]; fps: number; active: number | null; onPick(i: number): void }) {
  return (
    <ol className="rows">
      {rows.map((row, i) => (
        <li key={i}>
          <button className={row.f === active ? 'row-button active' : 'row-button'} onClick={() => onPick(i)}>
            <span>{row.main}</span>
            <span className="muted small">{[clock(row.f, fps), row.detail].filter(Boolean).join(' · ')}</span>
          </button>
        </li>
      ))}
    </ol>
  )
}

function Suggestions({ disabled = false }: { disabled?: boolean }) {
  const { ask } = useStore.getState()
  return (
    <ul className="suggestions">
      {SUGGESTIONS.map((q) => (
        <li key={q}>
          <button className="link muted" disabled={disabled} onClick={() => void ask(q)}>
            {q}
          </button>
        </li>
      ))}
    </ul>
  )
}

function classTitle(tubes: Tubes, text: string, ready: boolean) {
  const classes = matchClasses(text, tubes)
  if (classes.length === 0) return `No class matches “${text.trim()}”`
  const n = matchingTracks(tubes, classes).length
  if (!ready) return n === 1 ? '1 track so far' : `${n} tracks so far`
  return n === 1 ? '1 track matches' : `${n} tracks match`
}

function useContent(search: Search, tubes: Tubes): { title: string; body: React.ReactNode } {
  const nearMisses = useStore((s) => s.nearMisses)
  const focus = useStore((s) => s.focus)
  const frame = useStore((s) => s.frame)
  const ready = useStore((s) => s.meta?.status === 'ready')
  const { focusNearMiss, jumpTo } = useStore.getState()
  const fps = tubes.video.fps

  const closest = nearMisses.length > 0 && (
    <Rows rows={nearMisses.map(fromNearMiss)} fps={fps} active={focus?.f ?? null} onPick={(i) => focusNearMiss(nearMisses[i]!)} />
  )
  const browse = (
    <>
      {closest}
      <p className="muted small section">Try asking</p>
      <Suggestions />
    </>
  )

  switch (search.kind) {
    case 'loading':
      return { title: 'Searching', body: <p className="muted">Looking for “{search.text}”…</p> }
    case 'error':
      return { title: 'No answer', body: <p className="muted">{search.message}</p> }
    case 'answer': {
      const list = search.answer.highlight.list
      return {
        title: search.answer.highlight.caption,
        body: (
          <>
            <p className="summary">{search.answer.summary}</p>
            <Rows rows={list.map(fromItem)} fps={fps} active={frame} onPick={(i) => jumpTo(list[i]!.f)} />
          </>
        ),
      }
    }
    case 'classes':
      return {
        title: classTitle(tubes, search.text, ready),
        body: (
          <>
            <p className="muted small section">Try asking</p>
            <Suggestions disabled={!ready} />
          </>
        ),
      }
    case 'idle':
      if (!ready) {
        return {
          title: 'Try asking',
          body: (
            <>
              <p className="muted small note">Questions and closest calls open once the video is ready. Search for cars or people now.</p>
              <Suggestions disabled />
            </>
          ),
        }
      }
      return { title: nearMisses.length > 0 ? 'Closest calls' : 'Try asking', body: closest ? browse : <Suggestions /> }
  }
}

const bodyKey = (search: Search) => (search.kind === 'classes' ? 'classes' : `${search.kind}:${'text' in search ? search.text : ''}`)

export function ResultsPanel({ tubes }: { tubes: Tubes }) {
  const search = useStore((s) => s.search)
  const open = useStore((s) => s.panelOpen)
  const { togglePanel } = useStore.getState()
  const { title, body } = useContent(search, tubes)

  return (
    <>
      <button className={open ? 'panel-tab link hidden' : 'panel-tab link'} onClick={togglePanel}>
        Show results
      </button>
      <aside className={open ? 'panel' : 'panel hidden'} aria-hidden={!open}>
        <header className="panel-head">
          <h2>{title}</h2>
          <button className="link muted" onClick={togglePanel}>
            Hide
          </button>
        </header>
        <div key={bodyKey(search)} className="fade-in">
          {body}
        </div>
      </aside>
    </>
  )
}
