export function clock(f: number, fps: number): string {
  const s = Math.max(0, Math.floor(f / fps))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
