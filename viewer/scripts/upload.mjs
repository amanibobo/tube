import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const BASE = process.env.BASE ?? 'http://localhost:5181/app'
const OUT = process.env.OUT ?? new globalThis.URL('../screenshots/upload/', import.meta.url).pathname
const CLIP = process.env.CLIP
const BROKEN = process.env.BROKEN
const TEXT = process.env.TEXT
const LONG = process.env.LONG
const CHROME =
  process.env.CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
const MIN_FREE_MB = 500

if (!CLIP || !BROKEN || !TEXT) throw new Error('Set CLIP, BROKEN and TEXT to a short video, an unreadable .mp4 and a text file.')

function freeMb() {
  const line = execFileSync('df', ['-m', '/System/Volumes/Data']).toString().trim().split('\n').pop()
  return Number(line.split(/\s+/)[3])
}

function guardDisk() {
  const free = freeMb()
  if (free < MIN_FREE_MB) {
    console.log(`STOP disk has ${free} MB free, under ${MIN_FREE_MB} MB`)
    process.exit(2)
  }
}

const results = {}
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) process.exitCode = 1
}
const settle = (page, ms = 600) => page.waitForTimeout(ms)
const shot = async (page, name) => {
  guardDisk()
  await page.evaluate((n) => window.__marks?.push([Math.round(performance.now()), `screenshot ${n}`]), name)
  await page.screenshot({ path: `${OUT}${name}.png` })
}
const store = (page, pick, arg) => page.evaluate(pick, arg)
const waitFor = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout })

const SAMPLER = () => {
  window.__samples = []
  window.__sampling = true
  let last = performance.now()
  window.__long = []
  const tick = (now) => {
    if (now - last > 20) window.__long.push([Math.round(now), Math.round(now - last)])
    window.__samples.push(now - last)
    last = now
    if (window.__sampling) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

function report(label, deltas) {
  const sorted = [...deltas].sort((a, b) => a - b)
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length
  const r = {
    fps: +(1000 / mean).toFixed(1),
    p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
    worstMs: +sorted[sorted.length - 1].toFixed(2),
    over20Ms: deltas.filter((d) => d > 20).length,
    frames: deltas.length,
  }
  results[label] = r
  console.log(label, r)
}

async function dragHandle(page, dx, dy, steps = 30) {
  const h = await page.evaluate(() => window.__tubewatch.handleScreen())
  await page.mouse.move(h.x, h.y)
  await page.mouse.down()
  await page.mouse.move(h.x + dx, h.y + dy, { steps })
  await page.mouse.up()
}

async function dropFile(page, path, name, type) {
  const bytes = readFileSync(path).toString('base64')
  await page.evaluate(
    ({ bytes, name, type }) => {
      const data = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([data], name, { type }))
      const fire = (kind) => window.dispatchEvent(new DragEvent(kind, { dataTransfer: transfer, bubbles: true, cancelable: true }))
      fire('dragenter')
      fire('dragover')
      window.__drop = () => fire('drop')
    },
    { bytes, name, type },
  )
}

mkdirSync(OUT, { recursive: true })
guardDisk()
const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const page = await context.newPage()
const errors = []
const logError = (text) => {
  errors.push(text)
  console.log(`error ${text.slice(0, 100)}`)
}
page.on('pageerror', (e) => logError(e.message))
page.on('console', (m) => m.type() === 'error' && logError(m.text()))

await page.goto(`${BASE}?nointro`)
await waitFor(page, () => window.__tubewatch?.store.getState().introDone && window.__tubewatch.store.getState().tubes)
const first = await store(page, () => {
  const s = window.__tubewatch.store.getState()
  return { id: s.videoId, newestReady: s.library.find((m) => m.status === 'ready')?.id, url: location.search }
})
check(first.id === first.newestReady, `opens the newest ready video (${first.id})`)
check(first.url.includes(`v=${first.id}`), `the current video is in the URL (${first.url})`)

await page.click('.library-current')
await settle(page, 400)
const rows = await page.locator('.library-row').count()
const libraryLength = await store(page, () => window.__tubewatch.store.getState().library.length)
check(rows === libraryLength && rows >= 2, `the switcher lists ${rows} videos`)
await shot(page, '10-library')

await page.keyboard.press('Escape')
await page.fill('.pill input', 'car')
await settle(page, 600)
await page.click('.library-current')
const other = await store(page, () => {
  const s = window.__tubewatch.store.getState()
  return s.library.find((m) => m.status === 'ready' && m.id !== s.videoId).id
})
await page.locator('.library-row').nth(await store(page, (id) => window.__tubewatch.store.getState().library.findIndex((m) => m.id === id), other)).click()
await waitFor(page, (id) => {
  const s = window.__tubewatch.store.getState()
  return s.videoId === id && s.tubes && s.introDone
}, other)
{
  const s = await store(page, () => {
    const st = window.__tubewatch.store.getState()
    return { input: st.input, search: st.search.kind, url: location.search, visible: window.__tubewatch.visibleTracks().length }
  })
  check(s.input === '' && s.search === 'idle' && s.visible === 0, `switching resets the search (${JSON.stringify(s)})`)
  check(s.url.includes(`v=${other}`), `switching updates the URL (${s.url})`)
}

{
  const intro = await context.newPage()
  await intro.goto(`${BASE}?v=${first.id}`)
  await waitFor(intro, () => window.__tubewatch?.store.getState().introDone, null)
  const before = await store(intro, () => window.__tubewatch.introStartedAt)
  await intro.evaluate((id) => window.__tubewatch.store.getState().select(id), other)
  await waitFor(intro, (t) => window.__tubewatch.introStartedAt > t && window.__tubewatch.store.getState().introDone, before)
  check(true, 'switching videos plays the intro again')
  await intro.close()
}

await dropFile(page, TEXT, 'notes.txt', 'text/plain')
await settle(page, 200)
check(await page.locator('.drop').isVisible(), 'dragging a file over the window shows the drop target')
await shot(page, '11-drop')
await page.evaluate(() => window.__drop())
await settle(page, 300)
{
  const text = await page.locator('.rail').innerText()
  check(/notes\.txt isn’t a video/.test(text), 'dropping a text file is rejected with a plain sentence')
  check(!(await page.locator('.drop').isVisible()), 'the drop target hides after the drop')
}

const cdp = await context.newCDPSession(page)
await cdp.send('Network.enable')
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 400 * 1024 })
const warmCalls = []
page.on('request', (r) => r.url().endsWith('/api/warm') && warmCalls.push(Date.now()))
// Chromium doesn't expose a multipart body holding a File, so this reads what the server took from it: meta.track.
const uploads = []
page.on('response', async (r) => {
  if (r.request().method() !== 'POST' || !r.url().endsWith('/api/videos') || !r.ok()) return
  const meta = await r.json().catch(() => null)
  uploads.push({ track: meta?.track?.map((t) => t.name).join(', ') ?? null })
})
await page.setInputFiles('#upload-input', CLIP)
await page.waitForSelector('.track-step', { timeout: 10000 })
check(warmCalls.length >= 1, 'picking a file warms the GPU before anything is sent')
{
  const value = await page.inputValue('#track-field')
  const chips = await page.locator('.track-chips .chip').allInnerTexts()
  check(value === 'cars, people, bikes', `the track step starts on the traffic default (${value})`)
  check(chips.includes('dog') && chips.length >= 4, `with suggestions from /api/trackable (${chips.join(', ')})`)
}
await shot(page, '16-track-step')
await page.click('.track-step button[type=submit]')
await waitFor(page, () => {
  const u = window.__tubewatch.store.getState().upload
  return u.kind === 'sending' && u.loaded > 0 && u.loaded < u.total
})
await settle(page, 300)
await shot(page, '12-uploading')
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })

const uploaded = await waitFor(page, (prev) => {
  const s = window.__tubewatch.store.getState()
  return s.videoId !== prev && s.meta?.title ? s.videoId : false
}, other).then((h) => h.jsonValue())
check(uploads.length === 1 && uploads[0].track === null, 'the default sends no track, so the server keeps its traffic default')
const stages = []
await page.exposeFunction('__stage', (s) => stages.push(s))
await page.evaluate(() => {
  let last = ''
  window.__marks = []
  window.__tubewatch.store.subscribe((s, prev) => {
    if (s.tubes !== prev.tubes) window.__marks.push([Math.round(performance.now()), `tubes ${s.tubes?.tracks.length}`])
    if (s.search !== prev.search) window.__marks.push([Math.round(performance.now()), `search ${s.search.kind}`])
    if (s.meta?.stage !== prev.meta?.stage) window.__marks.push([Math.round(performance.now()), `stage ${s.meta?.stage}`])
    const key = `${s.meta?.status}:${s.meta?.stage}`
    if (key !== last) window.__stage((last = key))
  })
})
await waitFor(page, () => {
  const s = window.__tubewatch.store.getState()
  return s.meta?.stage === 'segmenting' && s.tubes && s.introDone
})
check(await page.locator('.player video').isVisible(), 'the video card shows once normalizing is done')
check(await page.locator('.rail').innerText().then((t) => t.includes('Finding cars and people')), 'the stage reads "Finding cars and people"')

await page.evaluate(SAMPLER)
const sampleStartTracks = await store(page, () => window.__tubewatch.store.getState().tubes.tracks.length)
await page.evaluate(() => window.__tubewatch.store.getState().setFrame(40, 'scene'))
await settle(page, 300)
await dragHandle(page, 160, -40)
await settle(page, 300)
const scrubbed = await store(page, () => window.__tubewatch.store.getState())
check(scrubbed.frame > 40 && scrubbed.meta.status === 'processing', `scrubbed to frame ${scrubbed.frame} while ${scrubbed.meta.stage}`)

check(await page.locator('.suggestions button').first().isDisabled(), 'suggested questions are disabled while processing')
check(await page.locator('.panel').innerText().then((t) => /open once the video is ready/.test(t)), 'the panel says questions open once ready')
await page.fill('.pill input', 'every time a person and a car got close')
await page.press('.pill input', 'Enter')
await settle(page, 200)
{
  const s = await store(page, () => window.__tubewatch.store.getState().search)
  check(s.kind === 'error' && /ready/.test(s.message), `questions wait for ready (${s.message})`)
}
await page.fill('.pill input', 'car')
await waitFor(page, () => window.__tubewatch.visibleTracks().length >= 2 && window.__tubewatch.store.getState().meta.status === 'processing')
await settle(page, 500)
{
  const s = await store(page, () => {
    const st = window.__tubewatch.store.getState()
    return { tracks: st.tubes.tracks.length, visible: window.__tubewatch.visibleTracks().length, stage: st.meta.stage }
  })
  check(s.visible > 0, `partial tubes for "car" are visible while ${s.stage} (${s.visible} of ${s.tracks} tracks)`)
}
const beforeShot = await page.evaluate(() => {
  window.__sampling = false
  return { samples: window.__samples.slice(2), long: window.__long }
})
await shot(page, '13-processing')
await page.evaluate(SAMPLER)

await waitFor(page, () => window.__tubewatch.store.getState().meta.status === 'ready', null, 60000)
await settle(page, 800)
{
  const deltas = await page.evaluate(() => {
    window.__sampling = false
    return window.__samples.slice(2)
  })
  report('streaming tubes', [...beforeShot.samples, ...deltas])
  const after = await page.evaluate(() => ({ long: window.__long, marks: window.__marks }))
  const long = [...beforeShot.long, ...after.long]
  const marks = after.marks
  if (process.env.MARKS) console.log('marks', JSON.stringify(marks), 'long', JSON.stringify(long))
  results.longFrames = long.map(([t, d]) => {
    const before = marks.filter(([m]) => m <= t && m >= t - d - 400).map(([m, what]) => `${what} @-${t - m}ms`)
    return `${d}ms after ${before.join(', ') || 'no store change'}`
  })
  const s = await store(page, () => {
    const st = window.__tubewatch.store.getState()
    return { tracks: st.tubes.tracks.length, cars: st.tubes.tracks.filter((t) => t.class === 'car').length, visible: window.__tubewatch.visibleTracks().length }
  })
  results.tracksStreamed = { atSampleStart: sampleStartTracks, atReady: s.tracks }
  check(s.visible === s.cars, `every car tube shows once ready (${s.visible} of ${s.cars})`)
}
check(
  ['processing:segmenting', 'processing:building', 'processing:indexing', 'ready:null'].every((k) => stages.includes(k)),
  `stages advanced: ${stages.join(' → ')}`,
)

await page.click('.pill-clear')
await page.fill('.pill input', 'every time a person and a car got close')
await page.press('.pill input', 'Enter')
await waitFor(page, () => window.__tubewatch.store.getState().search.kind !== 'loading')
{
  const s = await store(page, () => window.__tubewatch.store.getState().search)
  check(s.kind === 'answer', `a cached question answers once ready: ${s.answer?.summary ?? s.message}`)
}
await settle(page, 900)
await shot(page, '14-ready')

await page.setInputFiles('#upload-input', BROKEN)
await page.click('.track-step button[type=submit]')
await waitFor(page, (id) => {
  const s = window.__tubewatch.store.getState()
  return s.videoId !== id && s.meta?.status === 'failed'
}, uploaded)
await settle(page, 400)
{
  const text = await page.locator('.rail').innerText()
  check(/could not be read as a video/.test(text), 'a failed job shows its error inline')
  check(await page.locator('text=Upload again').isVisible(), 'a failed job offers another upload')
}
await shot(page, '15-error')

if (LONG) {
  await page.setInputFiles('#upload-input', LONG)
  await page.click('.track-step button[type=submit]')
  await waitFor(page, () => window.__tubewatch.store.getState().notice !== null, null, 60000)
  const notice = await store(page, () => window.__tubewatch.store.getState().notice.text)
  const longId = await store(page, () => window.__tubewatch.store.getState().videoId)
  check(await page.locator('.rail').innerText().then((t) => t.includes(notice)), `the trim notice shows: ${notice}`)
  await page.evaluate((id) => window.__tubewatch.store.getState().select(id), other)
  await page.evaluate((id) => window.__tubewatch.store.getState().select(id), longId)
  await settle(page, 300)
  check(!(await page.locator('.rail').innerText()).includes(notice), 'the notice shows only once')
}

{
  await page.evaluate((id) => window.__tubewatch.store.getState().select(id), uploaded)
  await waitFor(page, (id) => window.__tubewatch.store.getState().videoId === id && window.__tubewatch.store.getState().tubes, uploaded)
  await settle(page, 600)
  const placeholder = await page.getAttribute('.pill input', 'placeholder')
  const questions = await page.locator('.suggestions button').allInnerTexts()
  check(placeholder === 'Search cars, people, or ask a question', `a traffic clip keeps its placeholder (${placeholder})`)
  check(questions[0] === 'Every time a person and a car got close', `and its traffic questions (${questions[0]})`)
}

{
  const sentBefore = uploads.length
  await page.setInputFiles('#upload-input', CLIP)
  await page.waitForSelector('.track-step', { timeout: 10000 })
  await page.fill('#track-field', 'unicorn')
  await page.click('.track-step button[type=submit]')
  await page.waitForSelector('.track-error', { timeout: 5000 })
  const message = await page.locator('.track-error').innerText()
  check(/can’t track “unicorn”/.test(message) && uploads.length === sentBefore, `an unknown name is refused before uploading: ${message}`)
  await shot(page, '17-track-unknown')
  await page.fill('#track-field', 'dog')
  await page.click('.track-step button[type=submit]')
  await waitFor(page, () => window.__tubewatch.store.getState().upload.kind === 'idle' && window.__tubewatch.store.getState().meta?.track?.length > 0)
  check(uploads.at(-1)?.track === 'dog', `the server received track=${uploads.at(-1)?.track}`)
  await waitFor(page, () => window.__tubewatch.store.getState().meta?.status === 'ready', null, 90000)
  await settle(page, 800)
  const placeholder = await page.getAttribute('.pill input', 'placeholder')
  check(placeholder === 'Search dogs, or ask a question', `the placeholder names this clip's class (${placeholder})`)
  const questions = await page.locator('.suggestions button').allInnerTexts()
  check(questions.length === 3 && questions.every((q) => /dog/.test(q)), `the suggestions ask about dogs (${questions.join(' / ')})`)
  check((await page.locator('.panel h2').innerText()) === 'Try asking' && (await page.locator('.rows').count()) === 0, 'no closest calls for a clip without people and vehicles')
  await page.fill('.pill input', 'dogs')
  await settle(page, 900)
  const lit = await page.evaluate(() => {
    const t = window.__tubewatch.store.getState().tubes
    const byId = new Map(t.tracks.map((x) => [x.id, x.class]))
    return { visible: window.__tubewatch.visibleTracks().map((id) => byId.get(id)), dogs: t.tracks.filter((x) => x.class === 'dog').length }
  })
  check(lit.visible.length === lit.dogs && lit.visible.every((c) => c === 'dog'), `"dogs" lights the ${lit.dogs} dog tubes only`)
  await shot(page, '18-dogs')
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
console.log(JSON.stringify(results, null, 2))
await browser.close()
