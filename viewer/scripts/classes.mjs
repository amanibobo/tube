import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

// A clip uploaded with `track=<CLASS>`: class search, placeholder, suggestions and an answered question all use its class.
const BASE = process.env.BASE ?? 'http://localhost:5181/app'
const VIDEO = process.env.VIDEO
const CLASS = process.env.CLASS ?? 'dog'
const PLURAL = process.env.PLURAL ?? `${CLASS}s`
const OUT = process.env.OUT ?? new globalThis.URL('../screenshots/upload/', import.meta.url).pathname
const CHROME =
  process.env.CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
if (!VIDEO) throw new Error(`Set VIDEO to a ready clip tracked as ${CLASS}.`)

const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) process.exitCode = 1
}
const shot = async (page, name) => {
  const free = Number(execFileSync('df', ['-m', '/System/Volumes/Data']).toString().trim().split('\n').pop().split(/\s+/)[3])
  if (free < 500) {
    console.log(`STOP disk has ${free} MB free`)
    process.exit(2)
  }
  await page.screenshot({ path: `${OUT}${name}.png` })
}
const lit = (page) =>
  page.evaluate(() => {
    const t = window.__tubewatch.store.getState().tubes
    const byId = new Map(t.tracks.map((x) => [x.id, x.class]))
    return window.__tubewatch.visibleTracks().map((id) => byId.get(id))
  })

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(`${m.text()} (${m.location().url})`))

await page.goto(`${BASE}?nointro&v=${VIDEO}`)
await page.waitForFunction(() => window.__tubewatch?.store.getState().railShown && window.__tubewatch.store.getState().tubes, null, { timeout: 60000 })
await page.waitForTimeout(1500)
const tubes = await page.evaluate(() => {
  const s = window.__tubewatch.store.getState()
  const classes = {}
  for (const t of s.tubes.tracks) classes[t.class] = (classes[t.class] ?? 0) + 1
  return { title: s.meta.title, track: s.meta.track, classes }
})
console.log('clip', JSON.stringify(tubes))
check((tubes.classes[CLASS] ?? 0) > 0, `the clip has ${tubes.classes[CLASS] ?? 0} ${CLASS} tracks`)

const placeholder = await page.getAttribute('.pill input', 'placeholder')
check(placeholder.startsWith(`Search ${PLURAL}`), `the placeholder names the clip's classes (${placeholder})`)
const questions = await page.locator('.suggestions button').allInnerTexts()
check(questions.length > 0 && questions.every((q) => q.includes(CLASS)), `the suggestions are about ${PLURAL} (${questions.join(' / ')})`)
const closest = await page.locator('.rows').count()
console.log(`closest calls shown: ${closest > 0}`)

await page.fill('.pill input', PLURAL)
await page.waitForTimeout(1200)
{
  const classes = await lit(page)
  check(classes.length === tubes.classes[CLASS] && classes.every((c) => c === CLASS), `"${PLURAL}" lights the ${classes.length} ${CLASS} tubes only`)
}
await shot(page, `19-${PLURAL}-live`)

await page.click('.pill-clear')
await page.waitForTimeout(400)
const question = questions[0]
await page.fill('.pill input', question)
await page.press('.pill input', 'Enter')
await page.waitForFunction(() => window.__tubewatch.store.getState().search.kind !== 'loading', null, { timeout: 120000 })
const search = await page.evaluate(() => window.__tubewatch.store.getState().search)
check(search.kind === 'answer', `"${question}" answered: ${search.answer?.summary ?? search.message}`)
if (search.kind === 'answer') {
  await page.waitForTimeout(1200)
  const ids = [...new Set(search.answer.highlight.segments.map((s) => s.track_id))]
  const classes = await page.evaluate((ids) => {
    const t = window.__tubewatch.store.getState().tubes
    return ids.map((id) => t.tracks.find((x) => x.id === id)?.class)
  }, ids)
  const shown = await lit(page)
  check(ids.length > 0 && classes.every((c) => c === CLASS), `the answer highlights ${ids.length} ${CLASS} tracks (${ids.join(', ')})`)
  check(shown.length === ids.length, `and the cube shows exactly those (${shown.length} lit)`)
  if (search.answer.highlight.list[0]) {
    await page.click('.rows li:first-child button')
    await page.waitForTimeout(1000)
  }
  await shot(page, `20-${CLASS}-answer-live`)
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
await browser.close()
