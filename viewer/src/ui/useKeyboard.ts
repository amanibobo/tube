import { useEffect } from 'react'
import { playback } from '../playback'
import { useStore } from '../store'

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

export function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const store = useStore.getState()
      if (e.key === 'Escape') {
        if (store.libraryOpen) store.toggleLibrary(false)
        else store.clear()
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        return
      }
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      const fps = store.tubes?.video.fps ?? 30
      if (e.key === '/') {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('.pill input')?.focus()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const step = (e.shiftKey ? Math.round(fps) : 1) * (e.key === 'ArrowLeft' ? -1 : 1)
        store.setFrame(store.frame + step, 'scene')
      } else if (e.key === ' ') {
        e.preventDefault()
        playback.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
