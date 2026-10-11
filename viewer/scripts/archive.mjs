import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5180'
const VIDEO = process.env.VIDEO ?? 'pexels-junction'
const QUERY = process.env.QUERY ?? 'a bus turning'
const OUT = process.env.OUT ?? new globalThis.URL('../screenshots/archive/', import.meta.url).pathname
const CHROME =
  process.env.CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
const MIN_FREE_MB = 500
/** The hosted build: no Tube server, so Open in the cube is disabled with a note. */
const STATIC = process.env.STATIC === '1'
/** Send a real clip to Tube's server instead of intercepting the request. */
const REAL_CLIP = process.env.REAL_CLIP === '1'

const results = {}
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) process.exitCode = 1
}

function guardDisk() {
  const free = Number(execFileSync('df', ['-m', '/System/Volumes/Data']).toString().trim().split('\n').pop().split(/\s+/)[3])
  if (free < MIN_FREE_MB) {
    console.log(`STOP disk has ${free} MB free, under ${MIN_FREE_MB} MB`)
    process.exit(2)
  }
}

const shot = async (page, name) => {
  guardDisk()
  await page.screenshot({ path: `${OUT}${name}.png` })
}

async function frameTimes(page, ms, during = async () => {}) {
  await page.evaluate(() => {
    window.__samples = []
    window.__sampling = true
    let last = performance.now()
    const tick = (now) => {
      window.__samples.push(now - last)
      last = now
      if (window.__sampling) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await Promise.all([page.waitForTimeout(ms), during()])
  const d = await page.evaluate(() => {
    window.__sampling = false
    return window.__samples.slice(2)
  })
  const sorted = [...d].sort((a, b) => a - b)
  const mean = d.reduce((a, b) => a + b, 0) / d.length
  return {
    fps: +(1000 / mean).toFixed(1),
    p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
    worstMs: +sorted[sorted.length - 1].toFixed(1),
    over20Ms: d.filter((x) => x > 20).length,
    frames: d.length,
  }
}

/** Which route stylesheets the page loaded: dev serves them as <style data-vite-dev-id>, a build as <link>. */
const stylesheets = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('style[data-vite-dev-id], link[rel=stylesheet]')]
      .map((el) => el.getAttribute('data-vite-dev-id') ?? el.getAttribute('href'))
      .filter((s) => !s.includes('fonts.googleapis'))
      .map((s) => s.replace(/^.*\/src\//, 'src/')),
  )

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
page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`))
// The browser logs these 404/400s as errors, but they are expected: the intercepted clip request answers 400 on
// purpose, and a processing video's /tubes answers 404 until its first tracks exist (Tube reads that as "not yet").
const expected = (url) => url.endsWith('/api/videos/clip') || /\/api\/videos\/[^/]+\/tubes$/.test(url)
page.on('console', (m) => m.type() === 'error' && !expected(m.location().url) && errors.push(`${page.url()}: ${m.text()} (${m.location().url})`))

const libraryAnswer = page.waitForResponse((r) => r.url().includes('/api/library'), { timeout: 90000 })
await page.goto(`${ORIGIN}/archive?v=${VIDEO}`)
const library = await (await libraryAnswer).json()
await page.waitForSelector('.stage.shown', { timeout: 90000 })
await page.waitForSelector('.loader', { state: 'detached', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(1500)
{
  const stats = await page.locator('.masthead-stats').innerText()
  const films = Number(/^(\d+)/.exec(stats)?.[1] ?? 0)
  results.library = stats
  check(films > 0, `archive loaded: ${await page.locator('.masthead-title').innerText()}, ${stats}`)
  check(await page.locator('.stage canvas').isVisible(), 'filmstrips draw on the canvas')
  const css = await stylesheets(page)
  check(css.length > 0 && css.every((s) => /archive/i.test(s)), `the archive page loads only its own stylesheet (${css.join(', ')})`)
  check(await page.evaluate(() => window.__tubewatch === undefined), 'Tube’s store and shortcuts are not on the archive page')
}
await shot(page, 'archive-library')
results['archive idle'] = await frameTimes(page, 5000)
console.log('archive idle', results['archive idle'])

const searched = page.waitForResponse((r) => r.url().includes('/api/search?'), { timeout: 60000 })
await page.fill('.pill input', QUERY)
await page.press('.pill input', 'Enter')
const body = await (await searched).json()
await page.waitForSelector('.pill-count', { timeout: 60000 })
{
  const heat = Object.values(body.heatmap?.films ?? {}).map((b64) => Buffer.from(b64, 'base64'))
  const hot = heat.reduce((n, h) => n + h.filter((v) => v > 0).length, 0)
  results.search = { query: QUERY, results: body.results.length, heatFilms: heat.length, hotFrames: hot, tookMs: body.took_ms }
  check(body.results.length > 0 && body.results.every((r, i) => r.rank === i), `"${QUERY}" returned ${body.results.length} moments ranked in order`)
  check(heat.length > 0 && hot > 0, `heat covers ${heat.length} films, ${hot} frames above zero`)
  check((await page.locator('.pill-count').innerText()) === String(body.results.length), 'the pill counts the moments')
}
await page.waitForTimeout(1200)
await shot(page, 'archive-search')
results['archive with results'] = await frameTimes(page, 5000)
console.log('archive with results', results['archive with results'])

await page.locator('.pill input').blur()
await page.keyboard.press('ArrowDown')
await page.waitForSelector('.hover .card video', { timeout: 15000 })
{
  const top = body.results[0]
  await page.waitForFunction(() => {
    const v = document.querySelector('.hover .card video')
    return v && !v.paused && v.currentTime > 0 && !document.querySelector('.card-still')
  }, null, { timeout: 30000 })
  const v = await page.evaluate(() => {
    const el = document.querySelector('.hover .card video')
    return { t: el.currentTime, paused: el.paused, src: el.currentSrc, label: document.querySelector('.card-label').innerText }
  })
  results.card = { top: { title: top.title, start: top.start }, video: v }
  check(v.src.startsWith('https://') && !v.src.startsWith(ORIGIN), `the card's video comes from the archive API (${new URL(v.src).host})`)
  check(!v.paused && v.t >= top.start - 0.05 && v.t < top.start + 3, `the top hit plays from ${top.start.toFixed(1)} s (at ${v.t.toFixed(2)} s)`)
  check(v.label.startsWith(top.title), `the card is labelled ${v.label}`)
}
await page.waitForTimeout(600)
await shot(page, 'archive-hit-card')

const cardText = () => page.locator('.hover .card-label').innerText()
const pinned = () => page.locator('.hover.pinned').count().then((n) => n > 0)
/** Click the lifted card the hover card points at: its connector ring sits on the card's top edge. */
async function clickShownHit() {
  const ring = await page.locator('.connector-ring').boundingBox()
  await page.mouse.move(ring.x + ring.width / 2, ring.y + ring.height / 2 + 10, { steps: 4 })
  await page.mouse.down()
  await page.mouse.up()
}
{
  const top = body.results[0]
  await clickShownHit()
  await page.waitForSelector('.hover.pinned', { timeout: 10000 })
  const label = await cardText()
  check(label.startsWith(top.title), `clicking the hit pins its card (${label})`)
  await page.waitForFunction(() => {
    const el = document.querySelector('.hover .card video')
    return el && !el.paused && el.currentTime > 0 && !document.querySelector('.card-still')
  }, null, { timeout: 30000 })
  const t0 = await page.evaluate(() => document.querySelector('.hover .card video').currentTime)
  for (const [x, y] of [[300, 700], [520, 600], [1300, 760]]) await page.mouse.move(x, y, { steps: 12 })
  await page.waitForTimeout(800)
  check((await pinned()) && (await cardText()) === label, 'hovering other strips leaves the pinned card in place')
  const v = await page.evaluate(() => {
    const el = document.querySelector('.hover .card video')
    return { t: el.currentTime, paused: el.paused }
  })
  check(!v.paused && v.t > t0, `the pinned moment keeps playing (${t0.toFixed(2)} s to ${v.t.toFixed(2)} s)`)
  await shot(page, 'archive-pinned')

  const clamped = await page.locator('.card-caption').evaluate((el) => ({ shown: el.clientHeight, full: el.scrollHeight }))
  await page.getByRole('button', { name: 'Expand' }).click()
  await page.waitForTimeout(300)
  const open = await page.locator('.card-caption').evaluate((el) => ({ shown: el.clientHeight, full: el.scrollHeight, clamp: getComputedStyle(el).webkitLineClamp }))
  check(open.shown >= open.full - 1 || open.shown > clamped.shown, `Expand shows the whole caption (${clamped.shown}px of ${clamped.full}px, then ${open.shown}px of ${open.full}px)`)
  await shot(page, 'archive-expanded')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check((await pinned()) && (await page.locator('.card-caption.full').count()) === 0, 'Esc first folds the caption back')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check(!(await pinned()), 'Esc again unpins')

  await page.keyboard.press('ArrowDown')
  await page.waitForSelector('.hover .card', { timeout: 10000 })
  await clickShownHit()
  await page.waitForSelector('.hover.pinned', { timeout: 10000 })
  const first = await cardText()
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(600)
  const second = await cardText()
  check((await pinned()) && second !== first && second.startsWith(body.results[1].title), `ArrowDown moves the pin (${first} to ${second})`)
  const empty = await page.evaluate(() =>
    [[1000, 150], [700, 170], [1300, 180], [400, 160], [1380, 880]].find(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS'),
  )
  await page.mouse.click(empty[0], empty[1])
  await page.waitForTimeout(300)
  check(!(await pinned()), 'a click on empty canvas unpins')
  await page.getByRole('button', { name: 'Unpin' }).count().then((n) => check(n === 0, 'no Unpin button once let go'))

  await page.keyboard.press('ArrowDown')
  await page.waitForSelector('.hover .card', { timeout: 10000 })
  await clickShownHit()
  await page.waitForSelector('.hover.pinned', { timeout: 10000 })
  const cube = page.getByRole('button', { name: 'Open in the cube' })
  if (STATIC) {
    check(await cube.isDisabled(), 'Open in the cube is disabled in the hosted build')
    check(await page.locator('.card-note', { hasText: 'needs Tube running locally' }).isVisible(), 'with a note saying it needs Tube running locally')
    await shot(page, 'archive-cube-static')
    await page.getByRole('button', { name: 'Unpin' }).click()
  } else {
    const film = library.films.find((f) => f.id === top.film_id)
    const want = { start: Math.round(Math.max(0, top.t - 20) * 10) / 10, end: Math.round(Math.min(film.duration, top.t + 20) * 10) / 10 }
    let sent = null
    if (!REAL_CLIP) {
      await page.route('**/api/videos/clip', (route) => {
        sent = route.request().postDataJSON()
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'That video could not be read.' }) })
      })
      await cube.click()
      await page.waitForSelector('.card-error', { timeout: 10000 })
      check((await page.locator('.card-error').innerText()) === 'That video could not be read.', 'an {error} from Tube shows on the card')
      const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`
      check(
        sent && sent.url === new URL(`/api/video/${film.id}`, sent.url).href && new URL(sent.url).host !== new URL(ORIGIN).host,
        `the clip asks for the film's video on the archive API (${sent?.url})`,
      )
      check(sent?.start_s === want.start && sent?.end_s === want.end, `the window is ±20 s around ${top.t} s, inside the film (${sent?.start_s} to ${sent?.end_s})`)
      check(sent?.title === `${film.title} · ${mmss(want.start)}–${mmss(want.end)}`, `the clip is titled ${sent?.title}`)
      await shot(page, 'archive-cube-error')
      await page.unroute('**/api/videos/clip')
      await page.route('**/api/videos/clip', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: VIDEO, title: 'mock', status: 'ready', stage: null, progress: 1, error: null, duration_s: 60 }) }),
      )
    }
    await cube.click()
    await page.waitForURL((u) => u.pathname === '/app' && u.searchParams.has('v'), { timeout: 60000 })
    const id = new URL(page.url()).searchParams.get('v')
    if (!REAL_CLIP) check(id === VIDEO, `Tube's answer decides the video the cube opens (${id})`)
    await page.waitForFunction((v) => window.__tubewatch?.store.getState().videoId === v && window.__tubewatch.store.getState().meta, id, { timeout: 60000 })
    const job = await page.evaluate(() => {
      const s = window.__tubewatch.store.getState()
      return { id: s.videoId, title: s.meta.title, status: s.meta.status, stage: s.meta.stage }
    })
    results.cube = job
    check(true, `Open in the cube lands on /app?v=${job.id} (${job.title}: ${job.status}${job.stage ? `, ${job.stage}` : ''})`)
    if (REAL_CLIP) {
      check(job.status === 'queued' || job.status === 'processing' || job.status === 'ready', `the cube shows the clip's job (${job.status})`)
      await page.waitForFunction(() => window.__tubewatch.store.getState().railShown, null, { timeout: 30000 })
      await page.waitForTimeout(1500)
      await shot(page, 'cube-from-archive')
      const stages = [`${job.status}:${job.stage}`]
      const startedAt = Date.now()
      let tookShot = false
      for (let end = Date.now() + 180_000; Date.now() < end; ) {
        const now = await page.evaluate(() => {
          const s = window.__tubewatch.store.getState()
          return { key: `${s.meta.status}:${s.meta.stage}`, status: s.meta.status, tracks: s.tubes?.tracks.length ?? 0 }
        })
        if (now.key !== stages.at(-1)) stages.push(now.key)
        if (!tookShot && now.tracks > 0 && now.status === 'processing') {
          await shot(page, 'cube-from-archive-processing')
          tookShot = true
        }
        if (now.status === 'ready' || now.status === 'failed') break
        await page.waitForTimeout(1000)
      }
      const final = await page.evaluate(() => {
        const s = window.__tubewatch.store.getState()
        return { status: s.meta.status, error: s.meta.error, tracks: s.tubes?.tracks.length ?? 0, frames: s.tubes?.video.frames ?? 0 }
      })
      results.cubeJob = { stages, seconds: Math.round((Date.now() - startedAt) / 1000), ...final }
      check(stages.length > 1, `the clip's stages advance: ${stages.join(' → ')}`)
      check(final.status === 'ready', `the clip is ready in the cube: ${final.tracks} tracks over ${final.frames} frames${final.error ? `, ${final.error}` : ''}`)
      if (final.status === 'ready') {
        await page.waitForTimeout(2000)
        await shot(page, 'cube-from-archive-ready')
      }
    }
    await page.unroute('**/api/videos/clip').catch(() => {})
    await page.goto(`${ORIGIN}/archive?v=${VIDEO}`)
    await page.waitForSelector('.stage.shown', { timeout: 90000 })
    await page.waitForTimeout(1000)
  }
}

await page.mouse.move(720, 450)
await page.mouse.move(724, 452)
const upload = page.getByRole('button', { name: 'Upload', exact: true })
check(await upload.isVisible(), 'the corner offers Upload')
await upload.click()
await page.waitForSelector('.panel', { timeout: 10000 })
await page.waitForTimeout(400)
check(await page.locator('.drop-line').isVisible(), `the upload panel opens (${await page.locator('.drop-line').innerText()})`)
await shot(page, 'archive-upload-panel')
await page.locator('.panel-close').click()

await page.click('.masthead-back >> text=Back to the cube')
await page.waitForURL(`${ORIGIN}/app?v=${VIDEO}`)
await page.waitForFunction(() => window.__tubewatch?.store.getState().tubes, null, { timeout: 60000 })
{
  const id = await page.evaluate(() => window.__tubewatch.store.getState().videoId)
  check(id === VIDEO, `Back to the cube opens Tube on ${id}`)
  const css = await stylesheets(page)
  check(!css.some((s) => /archive/i.test(s)), `Tube loads none of the archive’s styles (${css.join(', ')})`)
  check(await page.evaluate(() => !document.querySelector('.masthead')), 'no archive UI on the cube page')
}
await page.waitForFunction(() => window.__tubewatch.store.getState().railShown, null, { timeout: 30000 })
await page.click('text=Archive search')
await page.waitForURL(`${ORIGIN}/archive?v=${VIDEO}`)
await page.waitForSelector('.stage.shown', { timeout: 90000 })
check(true, 'Archive search opens the archive again')
{
  await page.waitForTimeout(800)
  const before = await page.evaluate(() => document.activeElement?.tagName)
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('/')
  check(await page.evaluate(() => window.__tubewatch === undefined), `Tube’s keys do nothing here (focus ${before}, no Tube store)`)
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
console.log(JSON.stringify(results, null, 2))
await browser.close()
