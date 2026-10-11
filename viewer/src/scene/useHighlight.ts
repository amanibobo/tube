import { useMemo } from 'react'
import { videoClasses } from '../classes'
import { deriveHighlight, type Highlight } from '../search'
import { useStore } from '../store'
import type { Tubes } from '../types'
import { CONTEXT_OPACITY, FULL_OPACITY } from './space'

export function useHighlight(tubes: Tubes): Highlight {
  const search = useStore((s) => s.search)
  const focus = useStore((s) => s.focus)
  // A string, so meta updates during processing don't make a new highlight unless the classes changed.
  const expected = useStore((s) => videoClasses(s.meta).join(','))
  return useMemo(() => deriveHighlight(search, focus, tubes, expected.split(',')), [search, focus, tubes, expected])
}

export function tubeOpacity(h: Highlight, id: number): number {
  if (!h.matched?.has(id)) return 0
  return h.segments.length > 0 ? CONTEXT_OPACITY : FULL_OPACITY
}
