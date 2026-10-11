import { useMemo } from 'react'
import { deriveHighlight, type Highlight } from '../search'
import { useStore } from '../store'
import type { Tubes } from '../types'
import { CONTEXT_OPACITY, FULL_OPACITY } from './space'

export function useHighlight(tubes: Tubes): Highlight {
  const search = useStore((s) => s.search)
  const focus = useStore((s) => s.focus)
  return useMemo(() => deriveHighlight(search, focus, tubes), [search, focus, tubes])
}

export function tubeOpacity(h: Highlight, id: number): number {
  if (!h.matched?.has(id)) return 0
  return h.segments.length > 0 ? CONTEXT_OPACITY : FULL_OPACITY
}
