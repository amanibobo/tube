import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

const BASE = process.env.BASE ?? 'http://localhost:5181/app'
const OUT = process.env.OUT ?? new globalThis.URL('../screenshots/real/', import.meta.url).pathname
const CHROME =
  process.env.CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const shot = async (name) => {
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT}${name}.png` })
  const visible = await page.evaluate(() => window.__tubewatch.visibleTracks().length)
  console.log(name, `${visible} tubes visible`)
}

await page.goto(`${BASE}?nointro`)
await page.waitForFunction(() => window.__tubewatch?.store.getState().introDone)
const video = await page.evaluate(() => window.__tubewatch.store.getState().tubes.video)
console.log('clip', video.id, `${video.frames} frames at ${video.fps} fps`)
await page.evaluate((f) => window.__tubewatch.store.getState().jumpTo(f), Math.round(video.frames / 3))
await page.waitForTimeout(2500)
await shot('01-idle')

await page.type('.pill input', 'car', { delay: 40 })
await shot('02-car')
await page.fill('.pill input', '')
await page.type('.pill input', 'person', { delay: 40 })
await shot('03-person')
await page.keyboard.press('Escape')
await shot('04-cleared')

await page.fill('.pill input', 'every time a person and a car got close')
await page.press('.pill input', 'Enter')
await page.waitForFunction(() => window.__tubewatch.store.getState().search.kind !== 'loading', null, { timeout: 20000 })
await shot('05-question')
await page.keyboard.press('Escape')

console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors')
await browser.close()
