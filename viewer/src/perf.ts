import { useStore } from './store'

declare global {
  interface Window {
    __tubewatch: {
      fps: number
      frameMs: number
      highlightAppliedAt: number
      introStartedAt?: number
      visibleTracks?: () => number[]
      visibleSlices?: () => number[]
      store: typeof useStore
      handleScreen?: () => { x: number; y: number }
    }
  }
}

window.__tubewatch = { fps: 0, frameMs: 0, highlightAppliedAt: 0, store: useStore }
