import { useEffect, useState } from 'react'
import { useStore } from '../store'

const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false

export function DropTarget() {
  const [over, setOver] = useState(false)

  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      depth++
      setOver(true)
    }
    const leave = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setOver(false)
    }
    const hover = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      depth = 0
      setOver(false)
      const file = e.dataTransfer?.files[0]
      if (file) void useStore.getState().pickFile(file)
    }
    const events = { dragenter: enter, dragleave: leave, dragover: hover, drop } as const
    for (const [name, fn] of Object.entries(events)) window.addEventListener(name, fn as EventListener)
    return () => {
      for (const [name, fn] of Object.entries(events)) window.removeEventListener(name, fn as EventListener)
    }
  }, [])

  if (!over) return null
  return (
    <div className="drop">
      <p>Drop a video to upload</p>
    </div>
  )
}
