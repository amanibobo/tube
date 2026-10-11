import { useLayoutEffect, useRef } from 'react'
import type * as THREE from 'three'
import type { Track } from '../types'

export type TrackObject<T> = { track: Track; object: T }

// Diffs by track identity: the store keeps unchanged tracks as the same objects across refetches, so a streamed chunk only builds its new tracks.
export function useTrackObjects<T extends THREE.Object3D>(tracks: Track[], build: (track: Track) => T, dispose: (object: T) => void) {
  const group = useRef<THREE.Group>(null)
  const objects = useRef(new Map<number, TrackObject<T>>())
  const builtWith = useRef(build)

  useLayoutEffect(() => {
    const g = group.current
    if (!g) return
    const map = objects.current
    const drop = (id: number) => {
      const entry = map.get(id)!
      g.remove(entry.object)
      dispose(entry.object)
      map.delete(id)
    }
    if (builtWith.current !== build) {
      for (const id of [...map.keys()]) drop(id)
      builtWith.current = build
    }
    const live = new Set<number>()
    for (const track of tracks) {
      live.add(track.id)
      const entry = map.get(track.id)
      if (entry?.track === track) continue
      if (entry) drop(track.id)
      const object = build(track)
      g.add(object)
      map.set(track.id, { track, object })
    }
    for (const id of [...map.keys()]) if (!live.has(id)) drop(id)
  }, [tracks, build, dispose])

  useLayoutEffect(() => {
    const map = objects.current
    return () => {
      for (const { object } of map.values()) {
        object.removeFromParent()
        dispose(object)
      }
      map.clear()
    }
  }, [dispose])

  return { group, objects }
}
