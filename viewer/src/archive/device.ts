/**
 * Uploads without sign-in belong to a random 128-bit id this browser keeps in localStorage and sends as
 * `Bearer device:<id>`. Whoever holds the id holds those uploads; clearing site data loses it.
 */
const KEY = 'vidsearch.device'
const ID = /^[0-9a-f]{32}$/

export function storedDeviceId(): string | null {
  try {
    const id = localStorage.getItem(KEY)
    return id && ID.test(id) ? id : null
  } catch {
    return null
  }
}

/** A new id, remembered when storage allows (otherwise it lasts as long as the page). */
export function newDeviceId(): string {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  try { localStorage.setItem(KEY, id) } catch { /* storage blocked */ }
  return id
}
