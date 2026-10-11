import { useEffect, useRef, useState } from 'react'
import type { Film, FilmId, UploadsMode } from './api'
import { useAccount, type Session, type Viewer } from './auth'
import { Panel, Percent, reducedMotion, type Tab } from './UploadPanel'
import { sentence, uploadActive, type Upload, type Uploads } from './uploads'

/** The uploads panel: closed, open on a tab, or playing its close animation before it unmounts. */
type PanelState = { kind: 'closed' } | { kind: 'open'; tab: Tab } | { kind: 'closing'; tab: Tab }

/** What the top-right corner offers, from the API's upload mode and this build's sign-in. */
type Corner =
  | { kind: 'hidden' }
  | { kind: 'sign-in'; notice: string | null }
  | { kind: 'signed-in'; viewer: Viewer }
  /** Uploads tied to this browser: `upload` and `my uploads` right in the corner, no account. */
  | { kind: 'device' }

function cornerFor(mode: UploadsMode, session: Session): Corner {
  if (mode === 'device') return { kind: 'device' }
  if (mode === 'off') return { kind: 'hidden' }
  if (session.status === 'signed-in') return { kind: 'signed-in', viewer: session.viewer }
  if (session.status === 'signed-out') return { kind: 'sign-in', notice: session.notice }
  return { kind: 'hidden' }  // still checking, or this build has no sign-in configured
}

/**
 * Top-right corner. Account mode: `sign in` when signed out; signed in, an initial with a menu. Device mode: `upload`
 * and `my uploads` links. Either way one uploads panel with those two tabs, and a progress chip while an upload runs.
 */
export function AccountCorner({ mode, noun, uploads, films, onLibraryChanged, onDeviceNeeded, onShowFilm }: {
  mode: UploadsMode
  /** What one item of this archive is called, for the panel's copy. */
  noun: string
  uploads: Uploads
  films: readonly Film[]
  onLibraryChanged: () => void
  /** Device mode: make sure this browser has its id before a panel asks the API about its uploads. */
  onDeviceNeeded: () => void
  /** Ease the camera to a film's strip. */
  onShowFilm: (id: FilmId) => void
}) {
  const { session, signIn, signOut } = useAccount()
  const [panel, setPanel] = useState<PanelState>({ kind: 'closed' })
  const [menu, setMenu] = useState(false)
  /** The upload the upload tab shows; null shows the form. Outlives tab switches and closing the panel. */
  const [viewing, setViewing] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const corner = cornerFor(mode, session)

  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => { if (!root.current?.querySelector('.account-bar')?.contains(e.target as Node)) setMenu(false) }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

  if (corner.kind === 'hidden') return null
  if (corner.kind === 'sign-in') {
    return (
      <div className="account">
        <div className="account-bar">
          <button type="button" className="account-link account-signin" onClick={signIn}>Sign in</button>
        </div>
        {corner.notice && <p className="account-notice">{corner.notice}</p>}
      </div>
    )
  }

  const openTab = (tab: Tab) => {
    if (corner.kind === 'device') onDeviceNeeded()
    setMenu(false)
    setPanel({ kind: 'open', tab })
  }
  const close = () => setPanel((p) => (p.kind !== 'open' ? p : reducedMotion() ? { kind: 'closed' } : { kind: 'closing', tab: p.tab }))
  const openOn = panel.kind === 'open' ? panel.tab : null
  const toggle = (tab: Tab) => (openOn === tab ? close() : openTab(tab))
  const active = uploads.list.find(uploadActive)
  return (
    <div className="account" ref={root}>
      <div className={`account-bar${corner.kind === 'device' ? ' device' : ''}`}>
        {active && <StatusChip upload={active} onClick={() => { setViewing(active.key); openTab('upload') }} />}
        {corner.kind === 'device' ? (
          <>
            <button type="button" className="account-link" aria-expanded={openOn === 'upload'} onClick={() => toggle('upload')}>Upload</button>
            <button type="button" className="account-link" aria-expanded={openOn === 'mine'} onClick={() => toggle('mine')}>My uploads</button>
          </>
        ) : (
          <>
            <button type="button" className="account-avatar" aria-label={`Account: ${corner.viewer.name}`} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <Avatar viewer={corner.viewer} />
            </button>
            {menu && (
              <div className="menu" role="menu">
                <p className="menu-who">{corner.viewer.name}</p>
                <button type="button" role="menuitem" onClick={() => openTab('upload')}>Upload</button>
                <button type="button" role="menuitem" onClick={() => openTab('mine')}>My uploads</button>
                <button type="button" role="menuitem" onClick={signOut}>Sign out</button>
              </div>
            )}
          </>
        )}
      </div>
      {panel.kind !== 'closed' && (
        <Panel
          tab={panel.tab}
          closing={panel.kind === 'closing'}
          onTab={openTab}
          onClose={close}
          onClosed={() => setPanel((p) => (p.kind === 'closing' ? { kind: 'closed' } : p))}
          noun={noun}
          uploads={uploads}
          films={films}
          viewing={viewing}
          onView={setViewing}
          browserOnly={corner.kind === 'device'}
          onLibraryChanged={onLibraryChanged}
          onShowFilm={(id) => { close(); onShowFilm(id) }}
        />
      )}
    </div>
  )
}

function Avatar({ viewer }: { viewer: Viewer }) {
  const [broken, setBroken] = useState(false)
  if (viewer.picture && !broken) return <img src={viewer.picture} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  return <span>{(viewer.name.trim()[0] ?? '?').toUpperCase()}</span>
}

function chipLabel(u: Upload): string {
  if (u.phase === 'sending') return u.size ? 'Uploading' : 'Sending the link'
  if (u.phase === 'server' && u.job.state === 'processing' && u.job.stage) return sentence(u.job.stage)
  return 'Queued'
}

function StatusChip({ upload, onClick }: { upload: Upload; onClick: () => void }) {
  const progress = upload.phase === 'refused' ? 0 : upload.progress
  return (
    <button type="button" className="chip" onClick={onClick} title={upload.title}>
      <span className="spinner" aria-hidden="true" />
      <span className="chip-text">{chipLabel(upload)}{upload.phase === 'sending' && !upload.size ? null : <> <Percent value={progress} /></>}</span>
    </button>
  )
}
