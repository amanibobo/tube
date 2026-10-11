// Snapshots videos from a running Tube server into public/demo/ for the hosted, server-less demo
// (VITE_STATIC=1). It saves the server's answer to every question in that video's answer cache.
//
//   node scripts/export-static.mjs pexels-junction
//   SERVER=http://localhost:8000 DATA=../data node scripts/export-static.mjs <id> ...
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SERVER = process.env.SERVER ?? 'http://localhost:8000'
const DATA = process.env.DATA ?? '../data'
const OUT = 'public/demo'

const ids = process.argv.slice(2)
if (!ids.length) throw new Error('Name at least one video id, e.g. pexels-junction')

const get = async (path, init) => {
  const res = await fetch(`${SERVER}${path}`, init)
  if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  return res.json()
}
const write = (path, value) => writeFileSync(join(OUT, path), JSON.stringify(value))

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const metas = []
const answers = {}
for (const id of ids) {
  const base = `/api/videos/${encodeURIComponent(id)}`
  const meta = await get(base)
  if (meta.status !== 'ready') throw new Error(`${id} is ${meta.status}, not ready`)
  mkdirSync(join(OUT, id), { recursive: true })
  metas.push(meta)
  write(`${id}/meta.json`, meta)
  write(`${id}/tubes.json`, await get(`${base}/tubes`))
  write(`${id}/near-misses.json`, await get(`${base}/near-misses?top_k=10`))
  cpSync(join(DATA, id, 'video.mp4'), join(OUT, id, 'video.mp4'))
  cpSync(join(DATA, id, 'frames'), join(OUT, id, 'frames'), { recursive: true })

  const cached = Object.keys(JSON.parse(readFileSync(join(DATA, id, 'agent_cache.json'), 'utf8')))
  answers[id] = {}
  for (const q of cached) {
    const r = await get(`${base}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: q }),
    })
    if (r.error) {
      console.log(`  skip "${q}": ${r.error}`)
      continue
    }
    answers[id][q] = { ...r, cached: true }
    console.log(`  "${q}": ${r.summary}`)
  }
  console.log(`${id}: ${Object.keys(answers[id]).length} answers`)
}
write('videos.json', metas)
write('answers.json', answers)
