import { useEffect, useState } from 'react'

export function FpsReadout() {
  const [text, setText] = useState('')
  useEffect(() => {
    const id = setInterval(() => {
      const { fps, frameMs } = window.__tubewatch
      setText(`${fps.toFixed(0)} fps, ${frameMs.toFixed(1)} ms`)
    }, 500)
    return () => clearInterval(id)
  }, [])
  return <span>{text}</span>
}
