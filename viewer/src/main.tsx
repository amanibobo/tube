import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

// One page per route, each a lazy chunk that brings only its own stylesheet: the archive and Tube both style
// `.pill`, `.panel` and `.row`, so their CSS must never share a page. Moving between them is a full page load.
const Landing = lazy(() => import('./landing/Landing').then((m) => ({ default: m.Landing })))
const Tube = lazy(() => import('./App').then((m) => ({ default: m.App })))
const Archive = lazy(() => import('./archive/ArchivePage').then((m) => ({ default: m.ArchivePage })))

function Page() {
  const path = location.pathname.replace(/\/+$/, '') || '/'
  if (path === '/') return <Landing />
  if (path === '/archive') return <Archive />
  return <Tube />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
)
