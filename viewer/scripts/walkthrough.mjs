import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'

const BASE = process.env.BASE ?? 'http://localhost:5180/app'
const OUT = process.env.OUT ?? new globalThis.URL('../screenshots/', import.meta.url).pathname
const ONLY_FPS = process.argv.includes('--fps-only')
const RECORD = !process.argv.includes('--no-record')
const CHROME =
  process.env.CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
const VIEWPORT = { width: 1440, height: 900 }
const VIDEO = process.env.VIDEO ? `v=${process.env.VIDEO}&` : ''

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    ...(process.env.UNCAPPED ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
  ],
})

const results = {}
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) process.exitCode = 1
}
const settle = (page, ms = 600) => page.waitForTimeout(ms)

const SAMPLER = () => {
  window.__samples = []
  window.__sampling = true
  let last = performance.now()
  const tick = (now) => {
    window.__samples.push([now, now - last])
    last = now
    if (window.__sampling) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

async function sample(page, label, during) {
  await page.evaluate(SAMPLER)
  await during()
  const deltas = await page.evaluate(() => {
    window.__sampling = false
    return window.__samples.slice(2).map(([, d]) => d)
  })
  return report(label, deltas)
}

function report(label, deltas) {
  const sorted = [...deltas].sort((a, b) => a - b)
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length
  const r = {
    fps: +(1000 / mean).toFixed(1),
    meanMs: +mean.toFixed(2),
    p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
    worstMs: +sorted[sorted.length - 1].toFixed(2),
    frames: deltas.length,
  }
  results[label] = r
  console.log(label, r)
  return r
}

async function openPage(query, options = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: Number(process.env.DSF ?? 2), ...options })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(`${BASE}?${VIDEO}${query}`)
  return { context, page, errors }
}

const visibleByClass = (page) =>
  page.evaluate(() => {
    const t = window.__tubewatch.store.getState().tubes
    const byId = new Map(t.tracks.map((x) => [x.id, x.class]))
    const out = {}
    for (const id of window.__tubewatch.visibleTracks()) out[byId.get(id)] = (out[byId.get(id)] ?? 0) + 1
    return out
  })

const countClass = (page, cls) =>
  page.evaluate((c) => window.__tubewatch.store.getState().tubes.tracks.filter((t) => t.class === c).length, cls)

const state = (page) =>
  page.evaluate(() => {
    const s = window.__tubewatch.store.getState()
    const v = document.querySelector('video')
    return { frame: s.frame, search: s.search, videoTime: v?.currentTime ?? null, fps: s.tubes?.video.fps }
  })

async function dragHandle(page, dx, dy, steps = 30) {
  const h = await page.evaluate(() => window.__tubewatch.handleScreen())
  await page.mouse.move(h.x, h.y)
  await page.mouse.down()
  await page.mouse.move(h.x + dx, h.y + dy, { steps })
  await page.mouse.up()
}

async function ask(page, text) {
  await page.fill('.pill input', text)
  await page.press('.pill input', 'Enter')
  await page.waitForFunction(() => window.__tubewatch.store.getState().search.kind !== 'loading', null, { timeout: 15000 })
}

// The fold intro, measured from the moment it starts until the overlay fades in.
{
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: Number(process.env.DSF ?? 2) })
  await context.addInitScript(SAMPLER)
  const page = await context.newPage()
  await page.goto(`${BASE}?${VIDEO}`)
  await page.waitForFunction(() => window.__tubewatch?.store.getState().introDone, null, { timeout: 20000 })
  await settle(page, 300)
  const deltas = await page.evaluate(() => {
    window.__sampling = false
    const from = window.__tubewatch.introStartedAt
    return window.__samples.filter(([t]) => t > from + 1).map(([, d]) => d)
  })
  report('intro', deltas)
  await context.close()
}

const { context, page, errors } = await openPage('nointro')
await page.waitForFunction(() => window.__tubewatch?.handleScreen && window.__tubewatch.store.getState().tubes)
await settle(page, 2500)
await page.screenshot({ path: `${OUT}01-idle.png` })
{
  const visible = await visibleByClass(page)
  check(Object.keys(visible).length === 0, `idle shows no tubes (${JSON.stringify(visible)})`)
}

const dataset = await page.evaluate(() => {
  const t = window.__tubewatch.store.getState().tubes
  return { tracks: t.tracks.length, frames: t.video.frames, trackFrames: t.tracks.reduce((n, x) => n + x.frames.length, 0) }
})
results.dataset = dataset
console.log('dataset', dataset)

await sample(page, 'idle', () => settle(page, 5000))
await sample(page, 'orbiting', async () => {
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(900, 650)
    await page.mouse.down()
    await page.mouse.move(980, 670, { steps: 20 })
    await page.mouse.move(900, 650, { steps: 20 })
    await page.mouse.up()
  }
})
await settle(page, 1500)
await page.fill('.pill input', 'car')
await settle(page, 1200)
results['car tubes visible'] = (await page.evaluate(() => window.__tubewatch.visibleTracks())).length
await sample(page, 'orbiting with car tubes', async () => {
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(900, 650)
    await page.mouse.down()
    await page.mouse.move(980, 670, { steps: 20 })
    await page.mouse.move(900, 650, { steps: 20 })
    await page.mouse.up()
  }
})
await page.fill('.pill input', '')
await settle(page, 1500)

if (!ONLY_FPS) {
  await page.evaluate(() => window.__tubewatch.store.getState().setFrame(300, 'scene'))
  await settle(page, 800)
  await dragHandle(page, 220, -60)
  await settle(page, 1000)
  let s = await state(page)
  check(s.frame > 400, `handle drag scrubbed to frame ${s.frame}`)
  check(s.videoTime !== null && Math.abs(s.videoTime * s.fps - s.frame) <= 1, `video at ${s.videoTime?.toFixed(2)}s matches frame ${s.frame}`)
  await page.screenshot({ path: `${OUT}02-scrub.png` })
  await sample(page, 'scrubbing', () => dragHandle(page, -60, 15, 40).then(() => dragHandle(page, 60, -15, 40)))

  const before = (await state(page)).frame
  await page.click('.player-bar .icon-button')
  await settle(page, 1500)
  await page.click('.player-bar .icon-button')
  s = await state(page)
  check(s.frame > before + 20, `playing the video moved the plane from ${before} to ${s.frame}`)

  await page.evaluate(() => {
    window.__lastKey = 0
    document.querySelector('.pill input').addEventListener('keydown', () => (window.__lastKey = performance.now()))
  })
  await sample(page, 'search fade', async () => {
    await page.type('.pill input', 'car', { delay: 40 })
    await settle(page, 400)
  })
  results['filter car ms'] = await page.evaluate(() => window.__tubewatch.highlightAppliedAt - window.__lastKey)
  s = await state(page)
  check(s.search.kind === 'classes' && s.search.text === 'car', 'typing car filters by class')
  {
    const visible = await visibleByClass(page)
    const cars = await countClass(page, 'car')
    check(Object.keys(visible).length === 1 && visible.car === cars, `car shows only the ${cars} car tubes (${JSON.stringify(visible)})`)
  }
  await page.screenshot({ path: `${OUT}03-car.png` })
  await page.fill('.pill input', '')
  await page.type('.pill input', 'person', { delay: 40 })
  await settle(page, 400)
  results['filter person ms'] = await page.evaluate(() => window.__tubewatch.highlightAppliedAt - window.__lastKey)
  await page.screenshot({ path: `${OUT}03-person.png` })
  {
    const visible = await visibleByClass(page)
    check(Object.keys(visible).length === 1 && visible.person > 0, `person shows only person tubes (${JSON.stringify(visible)})`)
  }
  await page.keyboard.press('Escape')
  await settle(page, 600)
  {
    const visible = await visibleByClass(page)
    const input = await page.inputValue('.pill input')
    check(Object.keys(visible).length === 0 && input === '', `Esc clears the search back to no tubes (${JSON.stringify(visible)})`)
  }
  await page.screenshot({ path: `${OUT}03-cleared.png` })

  await page.keyboard.press('/')
  check(await page.evaluate(() => document.activeElement === document.querySelector('.pill input')), '/ focuses the search')
  await page.keyboard.press('Escape')
  const k0 = (await state(page)).frame
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await settle(page, 200)
  const k1 = (await state(page)).frame
  check(k1 - k0 === 1 + Math.round(s.fps), `arrows step the frame (${k0} to ${k1})`)
  await page.keyboard.press(' ')
  await settle(page, 1000)
  await page.keyboard.press(' ')
  const k2 = (await state(page)).frame
  check(k2 > k1 + 10, `space plays and pauses (${k1} to ${k2})`)
  console.log('filter latency (keydown to first faded frame, ms)', results['filter car ms'], results['filter person ms'])
  check(results['filter car ms'] < 100 && results['filter person ms'] < 100, 'class filter starts under 100 ms')

  await ask(page, 'every time a person and a car got close')
  s = await state(page)
  check(s.search.kind === 'answer', `agent answered: ${s.search.answer?.summary ?? s.search.message}`)
  await settle(page, 800)
  await page.screenshot({ path: `${OUT}04-answer.png` })
  const top = s.search.answer?.highlight.list[0]
  await page.evaluate(() => {
    window.__seeks = 0
    document.querySelector('video').addEventListener('seeking', () => window.__seeks++)
  })
  await sample(page, 'jump', async () => {
    await page.click('.rows li:first-child button')
    await settle(page, 700)
  })
  await settle(page, 500)
  s = await state(page)
  check(top && s.frame === top.f, `clicking the top result eased to frame ${s.frame} (expected ${top?.f})`)
  check(Math.abs(s.videoTime * s.fps - s.frame) <= 1, `video followed the jump (${s.videoTime?.toFixed(2)}s)`)
  const seekCount = await page.evaluate(() => window.__seeks)
  check(seekCount === 1, `video sought ${seekCount} time(s) during the jump`)
  await page.screenshot({ path: `${OUT}04-jump.png` })

  await page.click('.pill-clear')
  await settle(page, 600)
  {
    const visible = await visibleByClass(page)
    check(Object.keys(visible).length === 0, `clearing with × returns to no tubes (${JSON.stringify(visible)})`)
  }
  await page.click('.rows li:first-child button')
  await settle(page, 900)
  s = await state(page)
  const nm = await page.evaluate(() => window.__tubewatch.store.getState().nearMisses[0])
  check(nm && s.frame === nm.f, `near-miss click jumped to frame ${s.frame}`)
  await page.screenshot({ path: `${OUT}04-near-miss.png` })

  await ask(page, 'which cars stopped in the crosswalk')
  s = await state(page)
  check(
    s.search.kind === 'answer' && /crosswalk/i.test(`${s.search.answer.summary} ${s.search.answer.highlight.caption}`),
    `crosswalk question answered: ${s.search.answer?.summary ?? s.search.message}`,
  )
  if (s.search.answer?.highlight.list[0]) await page.click('.rows li:first-child button')
  await settle(page, 1000)
  await page.screenshot({ path: `${OUT}05-crosswalk.png` })

  await page.click('text=Hide')
  await settle(page, 600)
  await page.screenshot({ path: `${OUT}06-panel-hidden.png` })
  await page.click('text=Show results')
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
await context.close()

if (RECORD && !ONLY_FPS) {
  const dir = `${OUT}recording/`
  const recordStart = Date.now()
  const rec = await openPage('', { recordVideo: { dir, size: VIEWPORT }, deviceScaleFactor: 1 })
  await rec.page.waitForFunction(() => window.__tubewatch?.store.getState().introDone, null, { timeout: 20000 })
  await settle(rec.page, 800)
  await ask(rec.page, 'every time a person and a car got close')
  await settle(rec.page, 800)
  const jumpAt = (Date.now() - recordStart) / 1000
  await rec.page.click('.rows li:nth-child(2) button')
  await settle(rec.page, 1500)
  const video = rec.page.video()
  await rec.context.close()
  const path = `${OUT}intro-and-jump.webm`
  renameSync(await video.path(), path)
  const sheet = (name, from, length, fps) =>
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', `${from}`, '-t', `${length}`, '-i', path, '-vf', `fps=${fps},scale=360:-1,tile=5x4`, '-frames:v', '1', `${OUT}${name}`])
  const total = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).toString())
  sheet('intro-frames.png', 0, 4, 5)
  sheet('jump-frames.png', Math.max(0, jumpAt - 0.1), 0.8, 25)
  console.log('recording', path, `${total.toFixed(1)} s`)
}

console.log(JSON.stringify(results, null, 2))
await browser.close()
