import { useEffect } from 'react'
import './base.css'
import './perf'
import './styles.css'
import { applyLayoutVars } from './layout'
import { Cube } from './scene/Cube'
import { useStore } from './store'
import { STATIC } from './api'
import { DropTarget } from './ui/DropTarget'
import { FpsReadout } from './ui/FpsReadout'
import { JobStatus } from './ui/JobStatus'
import { Library } from './ui/Library'
import { ResultsPanel } from './ui/ResultsPanel'
import { SearchPill } from './ui/SearchPill'
import { useKeyboard } from './ui/useKeyboard'
import { VideoPlayer } from './ui/VideoPlayer'

const debug = new URLSearchParams(location.search).has('debug')

export function App() {
  const videoId = useStore((s) => s.videoId)
  const tubes = useStore((s) => s.tubes)
  const sampling = useStore((s) => s.sampling)
  const loadError = useStore((s) => s.loadError)
  const railShown = useStore((s) => s.railShown)
  const panelOpen = useStore((s) => s.panelOpen)
  useKeyboard()

  useEffect(() => {
    applyLayoutVars(document.documentElement)
    void useStore.getState().start()
  }, [])

  const scene = videoId && tubes ? { id: videoId, tubes } : null

  return (
    <>
      {scene && <Cube key={scene.id} videoId={scene.id} tubes={scene.tubes} sampling={sampling} />}
      <div className={['ui', railShown ? '' : 'hidden', panelOpen ? 'panel-open' : ''].join(' ')}>
        <div className="rail">
          <Library />
          {scene && <VideoPlayer key={scene.id} id={scene.id} video={scene.tubes.video} />}
          <JobStatus />
          {loadError && <p className="muted">{loadError}</p>}
        </div>
        {scene && <ResultsPanel tubes={scene.tubes} />}
        {scene && <SearchPill />}
        <footer className="footer muted small">
          {debug && <FpsReadout />}
        </footer>
      </div>
      {!STATIC && <DropTarget />}
    </>
  )
}
