// File API + WebSocket broadcast.
// - File API: list/load/save/delete .excalidraw files on disk
// - Element endpoint: add elements to a file AND push to all browser clients via WS
// - WebSocket: browser connects, gets live updates when MCP modifies a file
//
// MCP server lives in mcp/index.ts; it talks to this server via HTTP.
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import http from 'http'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'

const PORT = Number(process.env.PORT || process.env.API_PORT || 4000)

// Canvas files live INSIDE this app folder by default, so a fresh clone just
// works — no setup.sh, no folder to pick. The default is resolved from THIS
// file's own location (not the process CWD), so it is the same folder no matter
// where the server is launched from. An explicit CANVAS_DIR (env or .env) still
// wins if you want the files stored elsewhere.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CANVAS_DIR = path.resolve(HERE, '..', 'canvas-data')
let CANVAS_DIR =
  process.env.CANVAS_DIR && process.env.CANVAS_DIR.trim()
    ? process.env.CANVAS_DIR.trim()
    : DEFAULT_CANVAS_DIR

if (!fs.existsSync(CANVAS_DIR)) fs.mkdirSync(CANVAS_DIR, { recursive: true })

const app = express()
app.use(cors())
app.use(express.json({ limit: '20mb' }))

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })
const clients = new Set<WebSocket>()

function broadcast(message: any) {
  const data = JSON.stringify(message)
  clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(data) } catch {}
    }
  })
}

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

const safe = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '')
const fileFor = (name: string) => path.join(CANVAS_DIR, `${safe(name)}.excalidraw`)

function readFile(name: string): { elements: any[]; appState: any } {
  const fp = fileFor(name)
  if (!fs.existsSync(fp)) return { elements: [], appState: {} }
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    return { elements: data.elements || [], appState: data.appState || {} }
  } catch {
    return { elements: [], appState: {} }
  }
}

function writeFile(name: string, elements: any[], appState: any = {}) {
  const fp = fileFor(name)
  const body = { type: 'excalidraw', version: 2, elements, appState }
  fs.writeFileSync(fp, JSON.stringify(body, null, 2), 'utf-8')
}

// Auto-backup before destructive ops (clear, replace, delete, sync)
const BACKUP_DIR = path.join(CANVAS_DIR, '_backups')
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })

function autoBackup(name: string): boolean {
  const current = readFile(name)
  if (current.elements.length === 0) return false
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupPath = path.join(BACKUP_DIR, `${safe(name)}_${ts}.excalidraw`)
  const body = { type: 'excalidraw', version: 2, elements: current.elements, appState: current.appState }
  fs.writeFileSync(backupPath, JSON.stringify(body, null, 2), 'utf-8')
  console.log(`[backup] ${name} → ${backupPath} (${current.elements.length} elements)`)
  // Keep only last 20 backups per file to avoid disk bloat
  const prefix = safe(name) + '_'
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter((f: string) => f.startsWith(prefix) && f.endsWith('.excalidraw'))
    .sort()
  if (backups.length > 20) {
    for (const old of backups.slice(0, backups.length - 20)) {
      fs.unlinkSync(path.join(BACKUP_DIR, old))
    }
  }
  return true
}

// MCP Test — verifies the MCP → API → WS → browser pipeline
app.post('/api/mcp-test', (_req, res) => {
  const name = activeFile
  const testId = `mcp-test-${Date.now()}`
  const testEl = { id: testId, type: 'rectangle', x: 50, y: -100, width: 200, height: 60, strokeColor: '#22c55e', backgroundColor: '#d3f9d8', text: `MCP OK (${name || 'no file'})` }
  if (name) {
    const current = readFile(name)
    writeFile(name, [...current.elements, testEl], current.appState)
  }
  broadcast({ type: 'elements_added', name, elements: [testEl] })
  setTimeout(() => {
    if (name) {
      const current = readFile(name)
      writeFile(name, current.elements.filter((e: any) => e.id !== testId), current.appState)
    }
    broadcast({ type: 'element_deleted', name, elementId: testId })
  }, 5000)
  res.json({ success: true, message: 'Test element created — auto-deletes in 5s' })
})

// --- File order ---
const ORDER_FILE = path.join(CANVAS_DIR, '_file-order.json')

function getFileOrder(): string[] {
  try {
    if (fs.existsSync(ORDER_FILE)) return JSON.parse(fs.readFileSync(ORDER_FILE, 'utf-8'))
  } catch {}
  return []
}

function saveFileOrder(order: string[]) {
  fs.writeFileSync(ORDER_FILE, JSON.stringify(order, null, 2), 'utf-8')
}

// --- File CRUD ---

app.get('/api/files', (_req, res) => {
  let order = getFileOrder()
  const allFiles = fs.readdirSync(CANVAS_DIR)
    .filter((f) => f.endsWith('.excalidraw'))
    .map((f) => {
      const stat = fs.statSync(path.join(CANVAS_DIR, f))
      const name = f.replace(/\.excalidraw$/, '')
      return { name, modified: stat.mtime.toISOString(), size: stat.size }
    })
  // Add any new files not in the order to the FRONT, so a freshly-created
  // canvas surfaces at the TOP of the list instead of being buried at the bottom.
  const newFiles = allFiles.filter(f => !order.includes(f.name)).map(f => f.name)
  if (newFiles.length > 0) {
    order = [...newFiles, ...order]
    saveFileOrder(order)
  }
  // Sort strictly by saved order
  const fileMap = new Map(allFiles.map(f => [f.name, f]))
  const sorted = order.filter(name => fileMap.has(name)).map(name => fileMap.get(name)!)
  res.json({ success: true, files: sorted })
})

app.post('/api/files/reorder', (req, res) => {
  const order: string[] = Array.isArray(req.body.order) ? req.body.order : []
  saveFileOrder(order)
  res.json({ success: true, order })
})

// --- Content search across all canvas files ---
// Scans every .excalidraw file's TYPED text (text elements, bound labels,
// frame names) and returns the names of files whose content matches the query.
// mtime-keyed cache so repeated keystrokes don't re-read unchanged files.
// NOTE: registered BEFORE `/api/files/:name` would be a param collision, but the
// distinct `/api/file-search` path avoids that entirely.
const searchTextCache = new Map<string, { mtimeMs: number; text: string }>()

function searchableText(fp: string, name: string, mtimeMs: number): string {
  const cached = searchTextCache.get(name)
  if (cached && cached.mtimeMs === mtimeMs) return cached.text
  let text = ''
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const els: any[] = Array.isArray(data.elements) ? data.elements : []
    const parts: string[] = []
    for (const el of els) {
      if (!el || el.isDeleted) continue
      if (typeof el.text === 'string') parts.push(el.text) // text + bound labels
      if (typeof el.name === 'string') parts.push(el.name) // frame names
    }
    text = parts.join('\n').toLowerCase()
  } catch {
    text = ''
  }
  searchTextCache.set(name, { mtimeMs, text })
  return text
}

app.get('/api/file-search', (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase()
  if (!q) return res.json({ success: true, matches: [] })
  let entries: string[]
  try {
    entries = fs.readdirSync(CANVAS_DIR).filter((f) => f.endsWith('.excalidraw'))
  } catch {
    return res.json({ success: true, matches: [] })
  }
  const matches: string[] = []
  for (const f of entries) {
    const fp = path.join(CANVAS_DIR, f)
    const name = f.replace(/\.excalidraw$/, '')
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(fp).mtimeMs
    } catch {
      continue
    }
    if (searchableText(fp, name, mtimeMs).includes(q)) matches.push(name)
  }
  res.json({ success: true, matches })
})

app.get('/api/files/:name', (req, res) => {
  const name = safe(req.params.name)
  const fp = fileFor(name)
  if (!fs.existsSync(fp)) {
    res.json({ success: true, exists: false, name, elements: [], appState: {} })
    return
  }
  const data = readFile(name)
  res.json({ success: true, exists: true, name, ...data })
})

app.put('/api/files/:name', (req, res) => {
  const name = safe(req.params.name)
  if (!name) return res.status(400).json({ success: false, error: 'invalid name' })
  writeFile(name, req.body.elements || [], req.body.appState || {})
  res.json({ success: true, name, savedAt: new Date().toISOString() })
})

app.delete('/api/files/:name', (req, res) => {
  const name = safe(req.params.name)
  autoBackup(name)
  const fp = fileFor(name)
  if (fs.existsSync(fp)) fs.unlinkSync(fp)
  broadcast({ type: 'file_deleted', name })
  res.json({ success: true, deleted: name })
})

// Rename a canvas file: move the .excalidraw on disk, then carry the name
// forward in the saved order (preserving position), any group membership, and
// the MCP active-file pointer. Distinct /rename subpath, so no /api/files/:name
// route collision.
app.post('/api/files/:name/rename', (req, res) => {
  const oldName = safe(req.params.name)
  const newName = safe(String(req.body?.newName || '').trim())
  if (!newName) return res.status(400).json({ success: false, error: 'newName required' })
  const oldFp = fileFor(oldName)
  if (!fs.existsSync(oldFp)) return res.status(404).json({ success: false, error: 'file not found' })
  if (newName === oldName) return res.json({ success: true, name: newName })
  const newFp = fileFor(newName)
  if (fs.existsSync(newFp)) return res.status(409).json({ success: false, error: 'a canvas with that name already exists' })
  try {
    fs.renameSync(oldFp, newFp)
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message })
  }
  // carry the name forward in the saved order, in place
  const order = getFileOrder()
  const oi = order.indexOf(oldName)
  if (oi !== -1) {
    order[oi] = newName
    saveFileOrder(order)
  }
  // carry forward in group membership
  const groups = readGroups()
  let groupsChanged = false
  for (const g of groups) {
    const gi = g.files.indexOf(oldName)
    if (gi !== -1) {
      g.files[gi] = newName
      groupsChanged = true
    }
  }
  if (groupsChanged) saveGroups(groups)
  // follow the MCP active-file pointer if it was the renamed file
  if (activeFile === oldName) {
    activeFile = newName
    broadcast({ type: 'active_file_changed', activeFile })
  }
  broadcast({ type: 'file_renamed', oldName, newName })
  res.json({ success: true, name: newName })
})

// --- Element ops (used by MCP) ---

// Append elements to a file. Persists to disk + broadcasts to all WS clients.
// The browser's WS handler calls bridge.addElements(elements) on receipt.
app.post('/api/files/:name/elements', (req, res) => {
  const name = safe(req.params.name)
  if (!name) return res.status(400).json({ success: false, error: 'invalid name' })
  const incoming: any[] = Array.isArray(req.body.elements) ? req.body.elements : []
  if (incoming.length === 0) return res.json({ success: true, added: 0 })

  const current = readFile(name)
  const merged = [...current.elements, ...incoming]
  writeFile(name, merged, current.appState)
  broadcast({ type: 'elements_added', name, elements: incoming })
  res.json({ success: true, added: incoming.length, total: merged.length })
})

// Replace all elements (used by clear_scene MCP tool)
app.post('/api/files/:name/replace', (req, res) => {
  const name = safe(req.params.name)
  autoBackup(name)
  const elements: any[] = Array.isArray(req.body.elements) ? req.body.elements : []
  const current = readFile(name)
  writeFile(name, elements, current.appState)
  broadcast({ type: 'scene_replaced', name, elements })
  res.json({ success: true, count: elements.length })
})

// ─── yctimlin MCP compatibility shim ────────────────────────────────────────
// yctimlin's MCP server expects a single global canvas. We translate its
// global-element calls into operations on whatever file is "active" (the file
// the browser is currently viewing). The browser POSTs /api/active-file when
// it navigates; the MCP then operates on that file.

let activeFile: string | null = null
const generateId = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

app.post('/api/active-file', (req, res) => {
  const name = safe(req.body?.name || '')
  activeFile = name || null
  broadcast({ type: 'active_file_changed', activeFile })
  res.json({ success: true, activeFile })
})

app.get('/api/active-file', (_req, res) => {
  res.json({ success: true, activeFile })
})

function requireActive(res: express.Response): string | null {
  if (!activeFile) {
    res.status(400).json({ success: false, error: 'no active file — browser must navigate to a file first' })
    return null
  }
  return activeFile
}

// GET all elements of the active file
app.get('/api/elements', (_req, res) => {
  const name = requireActive(res); if (!name) return
  const { elements } = readFile(name)
  res.json({ success: true, elements, count: elements.length })
})

// GET single element by id
app.get('/api/elements/:id', (req, res) => {
  const name = requireActive(res); if (!name) return
  const { elements } = readFile(name)
  const el = elements.find((e: any) => e.id === req.params.id)
  if (!el) return res.status(404).json({ success: false, error: 'not found' })
  res.json({ success: true, element: el })
})

// POST create one element
app.post('/api/elements', (req, res) => {
  const name = requireActive(res); if (!name) return
  const incoming = { ...req.body, id: req.body.id || generateId() }
  const current = readFile(name)
  const merged = [...current.elements, incoming]
  writeFile(name, merged, current.appState)
  broadcast({ type: 'elements_added', name, elements: [incoming] })
  res.json({ success: true, element: incoming })
})

// PUT update by id
app.put('/api/elements/:id', (req, res) => {
  const name = requireActive(res); if (!name) return
  const id = req.params.id
  const current = readFile(name)
  const idx = current.elements.findIndex((e: any) => e.id === id)
  if (idx === -1) return res.status(404).json({ success: false, error: 'not found' })
  const updated = { ...current.elements[idx], ...req.body, id }
  current.elements[idx] = updated
  writeFile(name, current.elements, current.appState)
  broadcast({ type: 'element_updated', name, element: updated })
  res.json({ success: true, element: updated })
})

// DELETE by id
app.delete('/api/elements/:id', (req, res) => {
  const name = requireActive(res); if (!name) return
  const id = req.params.id
  const current = readFile(name)
  const filtered = current.elements.filter((e: any) => e.id !== id)
  writeFile(name, filtered, current.appState)
  broadcast({ type: 'element_deleted', name, elementId: id })
  res.json({ success: true, deleted: id })
})

// POST batch create
app.post('/api/elements/batch', (req, res) => {
  const name = requireActive(res); if (!name) return
  const incoming: any[] = Array.isArray(req.body.elements) ? req.body.elements : []
  const withIds = incoming.map((e) => ({ ...e, id: e.id || generateId() }))
  const current = readFile(name)
  const merged = [...current.elements, ...withIds]
  writeFile(name, merged, current.appState)
  broadcast({ type: 'elements_added', name, elements: withIds })
  res.json({ success: true, elements: withIds, count: withIds.length })
})

// DELETE clear all elements (yctimlin uses DELETE /api/elements/clear)
app.delete('/api/elements/clear', (_req, res) => {
  const name = requireActive(res); if (!name) return
  autoBackup(name)
  const current = readFile(name)
  writeFile(name, [], current.appState)
  broadcast({ type: 'scene_replaced', name, elements: [] })
  res.json({ success: true, cleared: true })
})

// POST sync (yctimlin sometimes calls this — replaces with new element list)
app.post('/api/elements/sync', (req, res) => {
  const name = requireActive(res); if (!name) return
  autoBackup(name)
  const incoming: any[] = Array.isArray(req.body.elements) ? req.body.elements : []
  const current = readFile(name)
  writeFile(name, incoming, current.appState)
  broadcast({ type: 'scene_replaced', name, elements: incoming })
  res.json({ success: true, count: incoming.length, syncedAt: new Date().toISOString() })
})

// GET list backups for a file
app.get('/api/backups/:name', (req, res) => {
  const name = safe(req.params.name)
  const prefix = name + '_'
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter((f: string) => f.startsWith(prefix) && f.endsWith('.excalidraw'))
    .sort()
    .reverse()
    .map((f: string) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f))
      return { file: f, size: stat.size, modified: stat.mtime.toISOString() }
    })
  res.json({ success: true, name, backups })
})

// POST restore a backup
app.post('/api/backups/:name/restore', (req, res) => {
  const name = safe(req.params.name)
  const backupFile = req.body.file
  if (!backupFile) return res.status(400).json({ success: false, error: 'missing file param' })
  const bp = path.join(BACKUP_DIR, backupFile)
  if (!fs.existsSync(bp)) return res.status(404).json({ success: false, error: 'backup not found' })
  autoBackup(name)
  try {
    const data = JSON.parse(fs.readFileSync(bp, 'utf-8'))
    writeFile(name, data.elements || [], data.appState || {})
    broadcast({ type: 'scene_replaced', name, elements: data.elements || [] })
    res.json({ success: true, restored: backupFile, elements: (data.elements || []).length })
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// POST viewport — yctimlin calls this to scroll/zoom the canvas
app.post('/api/viewport', (req, res) => {
  const name = activeFile
  // Pass through to all browser clients via WS
  broadcast({ type: 'set_viewport', name, ...req.body })
  res.json({ success: true })
})

// GET search — filter elements by type, id, etc.
app.get('/api/elements/search', (req, res) => {
  const name = requireActive(res); if (!name) return
  const { elements } = readFile(name)
  const q = req.query as Record<string, string>
  const filtered = elements.filter((el: any) => {
    for (const [k, v] of Object.entries(q)) {
      if (v && String(el[k]) !== String(v)) return false
    }
    return true
  })
  res.json({ success: true, elements: filtered, count: filtered.length })
})

// ─── Snapshots (in-memory) ──────────────────────────────────────────────────
const snapshots = new Map<string, { name: string; elements: any[]; createdAt: string }>()

app.post('/api/snapshots', (req, res) => {
  const name = requireActive(res); if (!name) return
  const snapName: string = req.body?.name || `snap-${Date.now()}`
  const { elements } = readFile(name)
  snapshots.set(snapName, { name: snapName, elements, createdAt: new Date().toISOString() })
  res.json({ success: true, snapshot: { name: snapName, count: elements.length } })
})

app.get('/api/snapshots/:name', (req, res) => {
  const snap = snapshots.get(req.params.name)
  if (!snap) return res.status(404).json({ success: false, error: 'snapshot not found' })
  res.json({ success: true, ...snap })
})

app.get('/api/snapshots', (_req, res) => {
  res.json({ success: true, snapshots: Array.from(snapshots.values()).map((s) => ({ name: s.name, createdAt: s.createdAt, count: s.elements.length })) })
})

// ─── WebSocket request-response pattern ──────────────────────────────────────
// For tools that need browser-side processing (mermaid conversion, image export):
// 1. HTTP comes in
// 2. Server generates requestId, broadcasts WS message + holds Promise
// 3. Browser does the work, POSTs to /api/<thing>/result with the id
// 4. Server resolves Promise, returns to HTTP caller
const pendingRequests = new Map<string, (data: any) => void>()
function awaitBrowserResponse(timeoutMs = 15000): { id: string; promise: Promise<any> } {
  const id = Math.random().toString(36).slice(2)
  const promise = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { pendingRequests.delete(id); reject(new Error('timeout')) }, timeoutMs)
    pendingRequests.set(id, (data) => { clearTimeout(timer); resolve(data) })
  })
  return { id, promise }
}

// Mermaid conversion — browser has the @excalidraw/mermaid-to-excalidraw package
app.post('/api/elements/from-mermaid', async (req, res) => {
  const name = requireActive(res); if (!name) return
  const { mermaidDiagram, config } = req.body || {}
  if (!mermaidDiagram) return res.status(400).json({ success: false, error: 'mermaidDiagram required' })
  const { id, promise } = awaitBrowserResponse(30000)
  broadcast({ type: 'mermaid_convert_request', id, mermaidDiagram, config })
  try {
    const result = await promise
    res.json({ success: true, ...result })
  } catch (e) {
    res.status(504).json({ success: false, error: (e as Error).message })
  }
})

app.post('/api/elements/from-mermaid/result', (req, res) => {
  const { id, ...rest } = req.body || {}
  const handler = pendingRequests.get(id)
  if (handler) { handler(rest); pendingRequests.delete(id) }
  res.json({ success: true })
})

// Image export — browser uses Excalidraw's exportToBlob
app.post('/api/export/image', async (req, res) => {
  const { format = 'png', background = true } = req.body || {}
  const { id, promise } = awaitBrowserResponse(20000)
  broadcast({ type: 'export_image_request', id, format, background })
  try {
    const result = await promise
    res.json({ success: true, ...result })
  } catch (e) {
    res.status(504).json({ success: false, error: (e as Error).message })
  }
})

app.post('/api/export/image/result', (req, res) => {
  const { id, ...rest } = req.body || {}
  const handler = pendingRequests.get(id)
  if (handler) { handler(rest); pendingRequests.delete(id) }
  res.json({ success: true })
})

// Viewport result (for set_viewport that wants to confirm it ran)
app.post('/api/viewport/result', (req, res) => {
  const { id, ...rest } = req.body || {}
  const handler = pendingRequests.get(id)
  if (handler) { handler(rest); pendingRequests.delete(id) }
  res.json({ success: true })
})

// ─── Image binaries (Excalidraw `files` map for image elements) ─────────────
// yctimlin uses /api/files for both canvas list AND image binaries — we route
// by request shape. This is the binary subpath: /api/binaries
const binaries = new Map<string, any>()

app.get('/api/binaries', (_req, res) => {
  const obj: Record<string, any> = {}
  binaries.forEach((v, k) => { obj[k] = v })
  res.json({ files: obj })
})

app.post('/api/binaries', (req, res) => {
  const file = req.body
  if (file?.id) binaries.set(file.id, file)
  broadcast({ type: 'files_added', files: [file] })
  res.json({ success: true })
})

// ─── Settings ─────────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  res.json({
    success: true,
    canvasDir: CANVAS_DIR,
    backupDir: BACKUP_DIR,
    port: PORT,
  })
})

app.put('/api/settings', (req, res) => {
  const { canvasDir, backupDir } = req.body
  if (canvasDir && typeof canvasDir === 'string') {
    if (!fs.existsSync(canvasDir)) {
      try { fs.mkdirSync(canvasDir, { recursive: true }) } catch (e: any) {
        return res.status(400).json({ success: false, error: `Cannot create directory: ${e.message}` })
      }
    }
    CANVAS_DIR = canvasDir
    // Update .env file if it exists
    const envPath = path.join(process.cwd(), '.env')
    try {
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : ''
      if (envContent.includes('CANVAS_DIR=')) {
        envContent = envContent.replace(/CANVAS_DIR=.*/, `CANVAS_DIR=${canvasDir}`)
      } else {
        envContent += `\nCANVAS_DIR=${canvasDir}\n`
      }
      fs.writeFileSync(envPath, envContent, 'utf-8')
    } catch {}
    console.log(`[settings] Canvas dir updated: ${CANVAS_DIR}`)
  }
  if (backupDir && typeof backupDir === 'string') {
    if (!fs.existsSync(backupDir)) {
      try { fs.mkdirSync(backupDir, { recursive: true }) } catch (e: any) {
        return res.status(400).json({ success: false, error: `Cannot create backup dir: ${e.message}` })
      }
    }
    // Note: BACKUP_DIR is const derived from CANVAS_DIR — for custom backup path,
    // we'd need to make it mutable. For now, backup stays under CANVAS_DIR/_backups
  }
  res.json({ success: true, canvasDir: CANVAS_DIR, backupDir: BACKUP_DIR })
})

// ─── Groups ──────────────────────────────────────────────────────────────────

interface Group {
  id: string
  name: string
  color: string
  collapsed: boolean
  files: string[]
}

const GROUPS_FILE = path.join(CANVAS_DIR, '_groups.json')

function readGroups(): Group[] {
  try {
    if (fs.existsSync(GROUPS_FILE)) return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf-8'))
  } catch {}
  return []
}

function saveGroups(groups: Group[]) {
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2), 'utf-8')
}

app.get('/api/groups', (_req, res) => {
  res.json({ success: true, groups: readGroups() })
})

app.post('/api/groups', (req, res) => {
  const groups = readGroups()
  const name = (req.body.name || '').trim()
  if (!name) return res.status(400).json({ success: false, error: 'name required' })
  const id = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const color = req.body.color || '#3b82f6'
  const group: Group = { id, name, color, collapsed: false, files: [] }
  groups.push(group)
  saveGroups(groups)
  res.json({ success: true, group })
})

app.put('/api/groups/:id', (req, res) => {
  const groups = readGroups()
  const idx = groups.findIndex(g => g.id === req.params.id)
  if (idx === -1) return res.status(404).json({ success: false, error: 'group not found' })
  if (req.body.name !== undefined) groups[idx].name = req.body.name.trim()
  if (req.body.color !== undefined) groups[idx].color = req.body.color
  if (req.body.collapsed !== undefined) groups[idx].collapsed = Boolean(req.body.collapsed)
  if (Array.isArray(req.body.files)) groups[idx].files = req.body.files
  saveGroups(groups)
  res.json({ success: true, group: groups[idx] })
})

app.delete('/api/groups/:id', (req, res) => {
  let groups = readGroups()
  groups = groups.filter(g => g.id !== req.params.id)
  saveGroups(groups)
  res.json({ success: true })
})

app.post('/api/groups/:id/files', (req, res) => {
  const groups = readGroups()
  const fileName = (req.body.fileName || '').trim()
  if (!fileName) return res.status(400).json({ success: false, error: 'fileName required' })
  const idx = groups.findIndex(g => g.id === req.params.id)
  if (idx === -1) return res.status(404).json({ success: false, error: 'group not found' })
  // Remove from any other group first
  groups.forEach(g => { g.files = g.files.filter(f => f !== fileName) })
  groups[idx].files.push(fileName)
  saveGroups(groups)
  res.json({ success: true, group: groups[idx] })
})

app.delete('/api/groups/:groupId/files/:fileName', (req, res) => {
  const groups = readGroups()
  const idx = groups.findIndex(g => g.id === req.params.groupId)
  if (idx === -1) return res.status(404).json({ success: false, error: 'group not found' })
  groups[idx].files = groups[idx].files.filter(f => f !== req.params.fileName)
  saveGroups(groups)
  res.json({ success: true, group: groups[idx] })
})

app.post('/api/groups/reorder', (req, res) => {
  const order: string[] = Array.isArray(req.body.order) ? req.body.order : []
  const groups = readGroups()
  const map = new Map(groups.map(g => [g.id, g]))
  const sorted = order.filter(id => map.has(id)).map(id => map.get(id)!)
  const remaining = groups.filter(g => !order.includes(g.id))
  saveGroups([...sorted, ...remaining])
  res.json({ success: true })
})

// ────────────────────────────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[api] http://127.0.0.1:${PORT}`)
  console.log(`[api] ws://127.0.0.1:${PORT}/ws`)
  console.log(`[api] canvas dir: ${CANVAS_DIR}`)
})
