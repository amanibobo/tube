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
page.on('console', (m) => m.type() === 'error' && errors.push(`${page.url()}: ${m.text()}`))

await page.goto(`${ORIGIN}/archive?v=${VIDEO}`)
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
