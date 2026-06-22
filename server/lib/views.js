// Saved VIEWS — named snapshots of the whole multipane layout (how many windows
// + which chat sits in each slot). Persisted on THIS computer in server/data so
// they survive a browser change / cache clear and live alongside the projects,
// not in the browser's localStorage. The client owns the array; the server just
// stores it (whole-array replace on save), validating the essential shape.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(SERVER_ROOT, 'data')
const VIEWS_FILE = path.join(DATA_DIR, 'views.json')

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch {
    /* best effort */
  }
}

// One slot in a saved view — mirrors the frontend WorkTab. Kept lenient: a view
// is opaque layout data, so we coerce types but don't reject on extra fields.
function hydrateTab(t) {
  if (!t || typeof t !== 'object') return null
  if (typeof t.key !== 'string' || typeof t.projectId !== 'string') return null
  return {
    key: t.key,
    projectId: t.projectId,
    sessionId: typeof t.sessionId === 'string' ? t.sessionId : null,
    title: typeof t.title === 'string' ? t.title : '',
    empty: t.empty === true,
  }
}

function hydrateView(v) {
  if (!v || typeof v !== 'object') return null
  if (typeof v.id !== 'string' || typeof v.name !== 'string') return null
  if (!Array.isArray(v.tabs)) return null
  const windowCount = Number(v.windowCount)
  return {
    id: v.id,
    name: v.name,
    paneMode: v.paneMode === 'multi' ? 'multi' : 'single',
    windowCount: Number.isFinite(windowCount) && windowCount >= 2 && windowCount <= 6 ? Math.floor(windowCount) : 2,
    tabs: v.tabs.map(hydrateTab).filter(Boolean),
    activeKey: typeof v.activeKey === 'string' ? v.activeKey : null,
    // the Excalidraw canvas paired with this view (null = none) + its layout
    canvasFile: typeof v.canvasFile === 'string' ? v.canvasFile : null,
    canvasLayout: v.canvasLayout === 'split' ? 'split' : 'full',
  }
}

function coerce(list) {
  return (Array.isArray(list) ? list : []).map(hydrateView).filter(Boolean)
}

function loadStore() {
  ensureDataDir()
  let raw
  try {
    raw = fs.readFileSync(VIEWS_FILE, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.views) ? parsed.views : []
    return coerce(list)
  } catch (err) {
    const backup = `${VIEWS_FILE}.corrupt-${Date.now()}`
    try {
      fs.renameSync(VIEWS_FILE, backup)
      console.error(`views.json is corrupt (${err?.message}); moved it to ${backup}`)
    } catch {
      /* ignore */
    }
    return []
  }
}

let views = loadStore()

// Atomic write (temp + rename) so a crash mid-write never truncates the store.
function saveStore() {
  ensureDataDir()
  const tmp = `${VIEWS_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ views }, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, VIEWS_FILE)
}

export function listViews() {
  return views.map((v) => ({ ...v, tabs: v.tabs.map((t) => ({ ...t })) }))
}

/** Replace the whole set of saved views (the client owns the array). */
export function replaceViews(list) {
  views = coerce(list)
  saveStore()
  return listViews()
}
