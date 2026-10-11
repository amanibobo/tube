import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { fetchVoiceToken, HttpError } from './api'

/**
 * One voice search, from the mic button to a transcript. The browser streams 16 kHz PCM straight to ElevenLabs'
 * realtime speech-to-text with a single-use token from our API, so the API key never reaches the page.
 */
export type VoiceState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'connecting' }
  | { kind: 'listening'; committed: string; partial: string }
  /** Stopped by the user (or the time cap): waiting briefly for ElevenLabs to commit what was said. */
  | { kind: 'finishing'; committed: string; partial: string }
  /** `message` fits the pill; `detail` is the full explanation, for its tooltip. */
  | { kind: 'error'; message: string; detail: string }

/** `auto`: ElevenLabs heard the end of the query (VAD commit), so it runs. `stopped`: the user stopped; the text is left to edit. */
export type Ending = 'auto' | 'stopped'

const SAMPLE_RATE = 16000
const CHUNK_SAMPLES = SAMPLE_RATE / 10
const MAX_LISTEN_MS = 30_000
const FINISH_WAIT_MS = 1500
const STT_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
const STT_PARAMS = { model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', commit_strategy: 'vad', language_code: 'en', vad_silence_threshold_secs: '0.9' }

// Averages each run of input samples into one 16 kHz sample (a crude low-pass, plenty for speech) and posts 100 ms of
// Int16 PCM at a time with the RMS of the input it came from.
const WORKLET = `
class Pcm16k extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / ${SAMPLE_RATE}; this.pos = 0; this.acc = 0; this.n = 0; this.sq = 0; this.m = 0; this.fresh() }
  fresh() { this.out = new Int16Array(${CHUNK_SAMPLES}); this.len = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i]
      this.acc += x; this.n++; this.sq += x * x; this.m++
      if (++this.pos < this.ratio) continue
      this.pos -= this.ratio
      const v = Math.max(-1, Math.min(1, this.acc / this.n))
      this.out[this.len++] = v < 0 ? v * 0x8000 : v * 0x7fff
      this.acc = 0; this.n = 0
      if (this.len === this.out.length) {
        this.port.postMessage({ pcm: this.out.buffer, rms: Math.sqrt(this.sq / this.m) }, [this.out.buffer])
        this.sq = 0; this.m = 0
        this.fresh()
      }
    }
    return true
  }
}
registerProcessor('pcm16k', Pcm16k)
`

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const chunkMessage = (audio: string, commit: boolean) =>
  JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: audio, commit, sample_rate: SAMPLE_RATE })

type Failure = { message: string; detail: string }
const SERVICE: Failure = { message: 'Voice unavailable', detail: 'The voice service is unavailable. Try again or type your search.' }

function micFailure(e: unknown): Failure {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return { message: 'Microphone blocked', detail: 'Allow the microphone for this site to search by voice.' }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { message: 'No microphone found', detail: 'Connect a microphone to search by voice.' }
  return { message: 'Microphone unavailable', detail: e instanceof Error ? e.message : String(e) }
}

function tokenFailure(e: unknown): Failure {
  if (e instanceof HttpError && e.status === 429) return { message: 'Voice limit reached', detail: e.detail ?? 'voice search limit reached; try again later' }
  return SERVICE
}

/** ElevenLabs' typed errors that mean the account's allowance, not a fault. */
const LIMIT_ERRORS = new Set(['quota_exceeded', 'rate_limited', 'session_time_limit_exceeded', 'resource_exhausted', 'queue_overflow'])

function sttFailure(type: string, error: string): Failure {
  if (LIMIT_ERRORS.has(type)) return { message: 'Voice limit reached', detail: error || type }
  if (type === 'insufficient_audio_activity') return { message: 'No speech heard', detail: error || 'No speech heard. Try again closer to the microphone.' }
  return { message: SERVICE.message, detail: error || type }
}

interface Handlers {
  state(s: VoiceState): void
  level(rms: number): void
  /** The session is over with this text (possibly empty). Not called after a failure or a cancel. */
  done(text: string, ending: Ending): void
}

export interface VoiceSession {
  /** Stop listening and keep what was said. Before audio flows, the same as cancel. */
  stop(): void
  /** Drop everything now; the session ends idle. */
  cancel(): void
}

/** Runs one session: microphone, token, socket, transcript. Every exit path tears down all three. */
export function openVoiceSession(on: Handlers): VoiceSession {
  let phase: VoiceState['kind'] | 'over' = 'requesting'
  let committed = ''
  let partial = ''
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  let ws: WebSocket | null = null
  const pending: string[] = []
  const timers: number[] = []
  const abort = new AbortController()
  // A function, not an inline comparison: awaits in run() let other callbacks end the session meanwhile.
  const over = () => phase === 'over'

  const stopMic = () => {
    stream?.getTracks().forEach((t) => t.stop())
    void ctx?.close().catch(() => {})
    stream = null
    ctx = null
    on.level(0)
  }
  const teardown = () => {
    phase = 'over'
    abort.abort()
    timers.forEach(clearTimeout)
    stopMic()
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close()
  }
  const set = (s: VoiceState) => { if (phase !== 'over') { phase = s.kind; on.state(s) } }
  const fail = (f: Failure) => { if (phase === 'over') return; set({ kind: 'error', ...f }); teardown() }
  const finish = (ending: Ending) => {
    if (phase === 'over') return
    const text = (committed || partial).trim()
    set({ kind: 'idle' })
    teardown()
    on.done(text, ending)
  }
  const cancel = () => { if (phase === 'over') return; set({ kind: 'idle' }); teardown() }
  const stop = () => {
    if (phase !== 'listening') return cancel()
    set({ kind: 'finishing', committed, partial })
    stopMic()
    ws?.send(chunkMessage('', true))
    timers.push(window.setTimeout(() => finish('stopped'), FINISH_WAIT_MS))
  }

  const onMessage = (raw: unknown) => {
    let msg: { message_type?: string; text?: string; error?: string }
    try {
      msg = JSON.parse(String(raw)) as typeof msg
    } catch {
      return fail(SERVICE)
    }
    const type = msg.message_type ?? ''
    if (type === 'session_started') {
      set({ kind: 'listening', committed, partial })
      pending.splice(0).forEach((m) => ws?.send(m))
      timers.push(window.setTimeout(stop, MAX_LISTEN_MS))
    } else if (type === 'partial_transcript') {
      partial = msg.text ?? ''
      if (phase === 'listening' || phase === 'finishing') set({ kind: phase, committed, partial })
    } else if (type === 'committed_transcript') {
      const text = (msg.text ?? '').trim()
      if (!text) return
      committed = text
      finish(phase === 'listening' ? 'auto' : 'stopped')
    } else if (type === 'error' || msg.error !== undefined) {
      if (phase === 'finishing') finish('stopped')
      else fail(sttFailure(type, msg.error ?? ''))
    }
  }

  const run = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
      return fail({ message: 'Voice not supported', detail: 'This browser (or an insecure page) has no microphone access.' })
    }
    set({ kind: 'requesting' })
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch (e) {
      return fail(micFailure(e))
    }
    if (over()) return stopMic()
    set({ kind: 'connecting' })
    const token = fetchVoiceToken(abort.signal)
    ctx = new AudioContext()
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    if (over() || !ctx || !stream) return
    const node = new AudioWorkletNode(ctx, 'pcm16k', { numberOfInputs: 1, numberOfOutputs: 0 })
    ctx.createMediaStreamSource(stream).connect(node)
    // Audio from before the socket opens is kept, so the first words aren't lost while it connects.
    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      if (phase === 'over' || phase === 'finishing') return
      on.level(e.data.rms)
      const m = chunkMessage(base64(e.data.pcm), false)
      if (phase === 'listening') ws?.send(m)
      else pending.push(m)
    }
    let t: string
    try {
      t = await token
    } catch (e) {
      return fail(tokenFailure(e))
    }
    if (over()) return
    ws = new WebSocket(`${STT_URL}?${new URLSearchParams({ ...STT_PARAMS, token: t })}`)
    ws.onmessage = (e) => onMessage(e.data)
    ws.onclose = () => { if (phase === 'finishing') finish('stopped'); else fail(SERVICE) }
  }
  run().catch((e: unknown) => fail({ ...SERVICE, detail: e instanceof Error ? e.message : String(e) }))
  return { stop, cancel }
}

/**
 * The pill's voice search. `levelEl` gets the mic's loudness as `--level` (0..1) straight on its style, so the ring
 * moves without a React render per audio chunk.
 */
export function useVoice(levelEl: RefObject<HTMLElement | null>, onDone: (text: string, ending: Ending) => void) {
  const [state, setState] = useState<VoiceState>({ kind: 'idle' })
  const session = useRef<VoiceSession | null>(null)
  const done = useRef(onDone)
  done.current = onDone

  const start = useCallback(() => {
    session.current?.cancel()
    session.current = openVoiceSession({
      state: setState,
      level: (rms) => levelEl.current?.style.setProperty('--level', Math.min(1, rms * 8).toFixed(3)),
      done: (text, ending) => done.current(text, ending),
    })
  }, [levelEl])
  const stop = useCallback(() => session.current?.stop(), [])
  const cancel = useCallback(() => session.current?.cancel(), [])
  const dismiss = useCallback(() => setState((s) => (s.kind === 'error' ? { kind: 'idle' } : s)), [])
  useEffect(() => () => session.current?.cancel(), [])
  return { state, start, stop, cancel, dismiss }
}

export const voiceActive = (s: VoiceState) => s.kind !== 'idle' && s.kind !== 'error'
