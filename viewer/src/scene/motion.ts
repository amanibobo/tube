import * as THREE from 'three'

export const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

export function approach(current: number, target: number, dt: number, tau = 0.06) {
  const next = current + (target - current) * (1 - Math.exp(-dt / tau))
  return Math.abs(next - target) < 0.002 ? target : next
}

const span = (now: number, from: number, to: number) => clamp01((now - from) / (to - from))

const skipIntro = () => new URLSearchParams(location.search).has('nointro')

export const intro = { startedAt: null as number | null, skipped: skipIntro() }

export type IntroPhase = { fly: number; fade: number; done: boolean }

export function introPhase(now: number): IntroPhase {
  if (intro.skipped) return { fly: 1, fade: 1, done: true }
  if (intro.startedAt === null) return { fly: 0, fade: 0, done: false }
  const t = now - intro.startedAt
  return {
    fly: easeInOutCubic(span(t, 0, 1100)),
    fade: easeInOutCubic(span(t, 400, 1600)),
    done: t >= 1700,
  }
}

export const FADE_TAU = 0.08
export const REVEAL_MS = 700

export const reveal = { startedAt: null as number | null }

export function revealProgress(now: number) {
  return reveal.startedAt === null ? 1 : easeOutCubic(span(now - reveal.startedAt, 0, REVEAL_MS))
}

export const growClip = new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6)

export type Jump = { from: number; to: number; startedAt: number; camera: { from: THREE.Vector3; to: THREE.Vector3 }; target: { from: THREE.Vector3; to: THREE.Vector3 } }

export const jump = { pending: null as number | null, active: null as Jump | null }

export const JUMP_MS = 400

export function requestJump(f: number) {
  jump.pending = f
}

export function resetMotion() {
  intro.startedAt = null
  intro.skipped = skipIntro()
  reveal.startedAt = null
  jump.pending = null
  jump.active = null
  growClip.constant = 1e6
}
