// Christopher OS server — Express + ws + node-pty + chokidar (port 4000).
//
// REST:
//   GET    /api/health
//   GET    /api/config
//   GET    /api/projects
//   POST   /api/projects
//   DELETE /api/projects/:id
//   GET    /api/projects/:id/sessions/:sessionId/messages
// WS:
//   /ws                              chat (stream-json passthrough) + sessions-updated pushes
//   /ws/terminal?projectId=&sessionId=   node-pty terminal ('new' => fresh session)

import express from 'express'
import cors from 'cors'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { readdir, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

import {
  HOME,
  GLOBAL_CLAUDE_DIR,
  SESSION_ID_RE,
  ValidationError,
  listProjects,
  listProjectsWithSessions,
  discoverProjects,
  listAllSessions,
  ensureProjectForCwd,
  getProject,
  createProject,
  deleteProject,
  updateProject,
  renameSession,
  deleteSession,
  getSessionMessages,
  searchSessionContent,
  resolveSessionById,
  moveSession,
  getSessionsForProject,
  sessionsDirFor,
  findProjectByCwd,
  getSessionTitle,
} from './lib/projects.js'
import {
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  addChatToGroup,
  removeChatFromGroup,
  findGroupsBySession,
  updateGroup,
  reorderGroups,
} from './lib/groups.js'
import { listViews, replaceViews } from './lib/views.js'
import {
  handleTerminalConnection,
  killAllTerminals,
  killSession,
  listLiveSessions,
  readSessionOutput,
  writeSessionInput,
  identityForToken,
} from './lib/terminal.js'
import { saveMemory, searchMemory, recentMemory, memoryFilePath, ensureMemoryFile } from './lib/memory.js'
import { createSessionWatchers } from './lib/watcher.js'

// Dedicated var, NOT process.env.PORT — on this machine PORT is globally set
// to 7777 (Christopher's own service), which would collide. Vite proxies /api
// and /ws to 4000, so this must stay 4000 unless explicitly overridden.
const PORT = process.env.COS_PORT || 4040

// node-pty on Windows occasionally throws from worker threads / deferred
// callbacks (ConPTY console-list races, transient create-process errors). Those
// flaky NATIVE errors must never take down the whole server — log and survive.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason)
})

const app = express()
// Local-app CORS: only browser pages served from THIS machine may call the API
// (blocks random websites driving the orchestrator/chat endpoints via XHR).
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) cb(null, true)
      else cb(null, false)
    },
  }),
)
app.use(express.json())

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'claude-manager', time: new Date().toISOString() })
})

app.get('/api/config', (_req, res) => {
  res.json({ globalClaudeDir: GLOBAL_CLAUDE_DIR, home: HOME })
})

// Directories Claude has already worked in (under ~/.claude/projects) — for the
// "pick an existing project" picker when registering a project.
app.get('/api/discover-projects', async (_req, res) => {
  try {
    const discovered = await discoverProjects()
    res.json({ discovered })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to discover projects' })
  }
})

// Every Claude session JSONL on this machine — powers the "This computer" tab.
// Proxy the Excalidraw canvas app's file list (it runs on 4111) so the sidebar's
// Canvas tab can list .excalidraw files without a cross-origin call.
const CANVAS_API = 'http://127.0.0.1:4111'
app.get('/api/canvas/files', async (_req, res) => {
  try {
    const r = await fetch(`${CANVAS_API}/api/files`)
    const body = await r.json()
    res.json({ ...body, running: true })
  } catch {
    res.json({ success: false, running: false, files: [], error: 'Canvas app is not running yet.' })
  }
})

// Launch the bundled Excalidraw canvas app (Vite 5111 + API 4111) in a new window
// — powers the Canvas tab's "Start Excalidraw" button when it isn't running.
app.post('/api/canvas/start', (_req, res) => {
  if (process.platform !== 'win32') {
    res.status(400).json({ error: 'Only wired for Windows right now' })
    return
  }
  try {
    const canvasDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'excalidraw-canvas')
    if (!existsSync(canvasDir)) {
      res.status(400).json({ error: 'excalidraw-canvas folder not found next to the server' })
      return
    }
    const stamp = `${process.pid}-${Math.round(process.hrtime()[1])}`
    const bat = path.join(os.tmpdir(), `cos-canvas-${stamp}.bat`)
    // PORT=4111 forces the canvas API off this machine's global PORT=7777
    const body = ['@echo off', `cd /d "${canvasDir}"`, 'set PORT=4111', 'npm run dev', ''].join('\r\n')
    writeFileSync(bat, body, 'utf8')
    execFile('cmd.exe', ['/c', 'start', 'Excalidraw Canvas', 'cmd', '/k', bat], { windowsHide: false })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to start the canvas app' })
  }
})

// Generic passthrough for the rest of the canvas file/group API (reorder, delete,
// groups CRUD, move-to-group, active-file) so the Canvas tab can mirror the
// excalidraw sidebar. Registered AFTER the specific /api/canvas/files + /start
// routes so those win. Forwards /api/canvas/<rest> -> <canvas>/api/<rest>.
app.all('/api/canvas/*', async (req, res) => {
  const sub = req.params[0] || ''
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  try {
    const r = await fetch(`${CANVAS_API}/api/${sub}${qs}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
    })
    const text = await r.text()
    res.status(r.status)
    res.type(r.headers.get('content-type') || 'application/json')
    res.send(text)
  } catch {
    res.status(502).json({ success: false, error: 'Canvas app is not running.' })
  }
})

app.get('/api/all-sessions', async (_req, res) => {
  try {
    const sessions = await listAllSessions()
    res.json({ sessions })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to list sessions' })
  }
})

// Reveal a chat's transcript (.jsonl) in the OS file manager, selected. Derives
// the path from cwd + sessionId under the global ~/.claude/projects.
app.post('/api/sessions/reveal-jsonl', (req, res) => {
  const cwd = typeof req.body?.cwd === 'string' ? req.body.cwd.trim() : ''
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : ''
  if (!SESSION_ID_RE.test(sessionId)) {
    res.status(400).json({ error: 'Invalid session id' })
    return
  }
  if (!cwd) {
    res.status(400).json({ error: 'cwd is required' })
    return
  }
  const file = path.join(
    sessionsDirFor({ claudeDir: GLOBAL_CLAUDE_DIR, fileDir: cwd }),
    `${sessionId}.jsonl`,
  )
  if (!existsSync(file)) {
    res.status(404).json({ error: `Transcript not found on disk: ${file}` })
    return
  }
  try {
    revealInOS(file)
    res.json({ path: file })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to open the transcript' })
  }
})

// Content search across session transcripts (reads the jsonl). `sessionIds` (CSV)
// restricts the scan — the Projects tab passes its members; Directories/Recent
// omit it to search every session on the machine.
app.get('/api/search-content', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    const idsRaw = typeof req.query.sessionIds === 'string' ? req.query.sessionIds.trim() : ''
    const sessionIds = idsRaw ? idsRaw.split(',').filter(Boolean) : null
    const matches = await searchSessionContent(q, { sessionIds })
    res.json({ matches })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Search failed' })
  }
})

// Read a session transcript by its cwd (no registered project needed) — powers
// the right-click "View" quick-look modal. The folder is derived from cwd under
// the global ~/.claude, which is where every machine-wide session lives.
app.get('/api/session-messages', async (req, res) => {
  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : ''
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : ''
  if (!SESSION_ID_RE.test(sessionId)) {
    res.status(400).json({ error: 'Invalid session id' })
    return
  }
  if (!cwd) {
    res.status(400).json({ error: 'cwd is required' })
    return
  }
  try {
    const messages = await getSessionMessages({ claudeDir: GLOBAL_CLAUDE_DIR, fileDir: cwd }, sessionId)
    if (messages === null) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    res.json({ messages })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to read session messages' })
  }
})

// Locate a session by id under a Claude projects directory (default the global
// one) and recover its cwd — powers "Add chat → By ID".
app.get('/api/resolve-session', async (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : ''
  const projectsDir = typeof req.query.projectsDir === 'string' ? req.query.projectsDir.trim() : ''
  if (!SESSION_ID_RE.test(sessionId)) {
    res.status(400).json({ error: 'Invalid session id' })
    return
  }
  try {
    const session = await resolveSessionById(sessionId, projectsDir)
    if (session === null) {
      res.status(404).json({ error: 'No session with that id was found in that directory' })
      return
    }
    res.json({ session })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to resolve session' })
  }
})

// Move a session transcript to another working directory (relocates the .jsonl)
// so it resumes in the new dir — powers per-chat "Change directory".
app.post('/api/sessions/move', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const session = await moveSession(b.sessionId, b.fromCwd, b.toCwd, b.claudeDir)
    res.json({ session })
  } catch (err) {
    const status = err instanceof ValidationError ? 400 : 500
    res.status(status).json({ error: err?.message || 'Failed to move session' })
  }
})

// Open a session that isn't in a registered project: ensure a hidden "loose"
// project for its EXACT cwd so the pane can resume claude in the right folder.
// Returns the project (with its sessions) — the FE keeps it for pane resolution
// but hides it from the sidebar Projects list.
app.post('/api/sessions/open-loose', async (req, res) => {
  try {
    const project = ensureProjectForCwd(req.body?.cwd)
    watchers.ensure(project)
    const sessions = await getSessionsForProject(project)
    res.json({ project: { ...project, sessions } })
  } catch (err) {
    const status = err instanceof ValidationError ? err.status : 500
    res.status(status).json({ error: err?.message || 'Failed to open session' })
  }
})

// Rename a session by id alone — used by Project group chats, which have no
// owning directory-project. The custom title is keyed globally by sessionId.
app.patch('/api/sessions/:sessionId', (req, res) => {
  try {
    const title = renameSession(req.params.sessionId, req.body?.title)
    res.json({ title })
  } catch (err) {
    res.status(err instanceof ValidationError ? 400 : 500).json({ error: err?.message || 'Failed to rename' })
  }
})

// Terminate a chat's live shell by cwd — Project/Directory chats carry a cwd,
// not a project id; the pty lives under the (ephemeral) project for that cwd.
app.post('/api/sessions/terminate', (req, res) => {
  const project = findProjectByCwd(String(req.body?.cwd || ''))
  if (!project) {
    res.json({ killed: false })
    return
  }
  res.json({ killed: killSession(project.id, String(req.body?.sessionId || '')) })
})

// — Chat groups: the dir-less "Project" model (a named set of chats from any
//   Claude directory). Each member carries its own cwd; opening it loose-opens.
const groupErr = (err, res, fallback) =>
  res.status(err instanceof ValidationError ? err.status : 500).json({ error: err?.message || fallback })

app.get('/api/groups', (_req, res) => {
  res.json({ groups: listGroups() })
})

app.post('/api/groups', (req, res) => {
  try {
    res.status(201).json({ group: createGroup(req.body?.name) })
  } catch (err) {
    groupErr(err, res, 'Failed to create project')
  }
})

// reorder projects (drag up/down) — registered before /:id so it isn't shadowed
app.post('/api/groups/reorder', (req, res) => {
  try {
    res.json({ groups: reorderGroups(req.body?.order) })
  } catch (err) {
    groupErr(err, res, 'Failed to reorder projects')
  }
})

app.patch('/api/groups/:id', (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const group = updateGroup(req.params.id, {
      name: b.name,
      directories: b.directories,
      directory: b.directory,
      description: b.description,
      color: b.color,
    })
    if (!group) return res.status(404).json({ error: 'Project not found' })
    res.json({ group })
  } catch (err) {
    groupErr(err, res, 'Failed to update project')
  }
})

app.delete('/api/groups/:id', (req, res) => {
  if (!deleteGroup(req.params.id)) return res.status(404).json({ error: 'Project not found' })
  res.json({ ok: true })
})

app.post('/api/groups/:id/chats', (req, res) => {
  try {
    const group = addChatToGroup(req.params.id, req.body?.sessionId, req.body?.cwd)
    if (!group) return res.status(404).json({ error: 'Project not found' })
    res.json({ group })
  } catch (err) {
    groupErr(err, res, 'Failed to add chat')
  }
})

app.delete('/api/groups/:id/chats/:sessionId', (req, res) => {
  const group = removeChatFromGroup(req.params.id, req.params.sessionId)
  if (!group) return res.status(404).json({ error: 'Project not found' })
  res.json({ group })
})

// Saved views (named multipane layouts) — stored on this computer in
// server/data/views.json, not the browser. The client owns the array and
// replaces the whole set on each change (matching its prior localStorage logic).
app.get('/api/views', (_req, res) => {
  res.json({ views: listViews() })
})

app.put('/api/views', (req, res) => {
  try {
    res.json({ views: replaceViews(req.body?.views) })
  } catch {
    res.status(400).json({ error: 'Failed to save views' })
  }
})

app.get('/api/projects', async (_req, res) => {
  try {
    const projects = await listProjectsWithSessions()
    res.json({ projects })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to list projects' })
  }
})

app.post('/api/projects', (req, res) => {
  try {
    const project = createProject(req.body)
    watchers.ensure(project)
    res.json({ project: { ...project, sessions: [] } })
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message })
    } else {
      res.status(500).json({ error: err?.message || 'Failed to create project' })
    }
  }
})

// Edit a project — name and/or file directory and/or Claude directory.
app.patch('/api/projects/:id', (req, res) => {
  try {
    const project = updateProject(req.params.id, req.body)
    if (!project) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    // the session folder may have moved (fileDir/claudeDir changed) — re-sync.
    watchers.sync(listProjects())
    res.json({ project })
  } catch (err) {
    const status = err instanceof ValidationError ? 400 : 500
    res.status(status).json({ error: err?.message || 'Failed to update project' })
  }
})

// Give a session a custom title (empty body title clears it).
app.patch('/api/projects/:id/sessions/:sessionId', (req, res) => {
  const project = getProject(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  try {
    const title = renameSession(req.params.sessionId, req.body?.title)
    res.json({ title })
  } catch (err) {
    const status = err instanceof ValidationError ? 400 : 500
    res.status(status).json({ error: err?.message || 'Failed to rename session' })
  }
})

// Terminate a session's live shell (kills the node-pty + its claude process).
app.post('/api/projects/:id/sessions/:sessionId/terminate', (req, res) => {
  const project = getProject(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  const killed = killSession(project.id, req.params.sessionId)
  res.json({ killed })
})

// Delete a session — kills its live shell, then soft-deletes the transcript.
app.delete('/api/projects/:id/sessions/:sessionId', async (req, res) => {
  const project = getProject(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  try {
    killSession(project.id, req.params.sessionId)
    await deleteSession(project, req.params.sessionId)
    res.json({ ok: true })
  } catch (err) {
    const status = err instanceof ValidationError ? 400 : 500
    res.status(status).json({ error: err?.message || 'Failed to delete session' })
  }
})

// The absolute path of this project's shared-memory file (for "copy path").
app.get('/api/projects/:id/memory/path', (req, res) => {
  const project = getProject(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  res.json({ path: memoryFilePath(project.id) })
})

// Open/reveal this project's memory file in the OS file manager (creates it
// first if it does not exist yet, so there is always something to show).
app.post('/api/projects/:id/memory/reveal', (req, res) => {
  const project = getProject(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  try {
    const file = ensureMemoryFile(project.id)
    revealInOS(file)
    res.json({ path: file })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to open memory file' })
  }
})

// Open this project's working directory (fileDir) in the OS file manager.
app.post('/api/projects/:id/reveal-dir', (req, res) => {
  const project = getProject(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  const dir = project.fileDir
  if (!dir || !existsSync(dir)) {
    res.status(400).json({ error: `Project directory not found on disk: ${dir || '(empty)'}` })
    return
  }
  try {
    openDirInOS(dir)
    res.json({ path: dir })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to open project directory' })
  }
})

// Open an arbitrary folder (e.g. a project's reference directory) in the OS file
// manager. Local-app only — CORS already restricts callers to localhost pages.
app.post('/api/reveal-path', (req, res) => {
  const raw = typeof req.body?.path === 'string' ? req.body.path.trim() : ''
  const dir = raw ? path.normalize(raw) : ''
  if (!dir) {
    res.status(400).json({ error: 'path is required' })
    return
  }
  if (!existsSync(dir)) {
    res.status(400).json({ error: `Folder not found on disk: ${dir}` })
    return
  }
  try {
    openDirInOS(dir)
    res.json({ path: dir })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to open folder' })
  }
})

// Run a project directory's saved command in a NEW terminal window at that dir.
app.post('/api/run-command', (req, res) => {
  const rawDir = typeof req.body?.dir === 'string' ? req.body.dir.trim() : ''
  const dir = rawDir ? path.win32.normalize(rawDir) : ''
  const command = typeof req.body?.command === 'string' ? req.body.command.trim() : ''
  if (!command) {
    res.status(400).json({ error: 'No command set for this directory' })
    return
  }
  if (!dir || !existsSync(dir)) {
    res.status(400).json({ error: `Folder not found on disk: ${dir || '(empty)'}` })
    return
  }
  if (process.platform !== 'win32') {
    res.status(400).json({ error: 'Run is only wired for Windows right now' })
    return
  }
  try {
    // Write a tiny .bat and launch it in a new window — putting the dir + command
    // INSIDE the script avoids the quote-mangling that breaks `cmd /c start cmd /k
    // "cd /d <dir> && <cmd>"` (paths with spaces/parens get corrupted otherwise).
    const stamp = `${process.pid}-${Math.round(process.hrtime()[1])}`
    const bat = path.join(os.tmpdir(), `cos-run-${stamp}.bat`)
    const body = ['@echo off', `cd /d "${dir}"`, 'echo Running: ' + command, command, ''].join('\r\n')
    writeFileSync(bat, body, 'utf8')
    // start in a new window; cmd /k keeps it open after the command finishes
    execFile('cmd.exe', ['/c', 'start', '', 'cmd', '/k', bat], { windowsHide: false })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to launch the command' })
  }
})

// ─── Ports ─────────────────────────────────────────────────────────────────
// List listening TCP ports + their owning process, and stop a process by PID.
// Windows-only (netstat + tasklist / taskkill). Powers the Settings → Ports tab.

/** Map each PID to its image name via one bulk `tasklist` CSV call. */
function resolveProcessNames() {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FO', 'CSV', '/NH'],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const map = new Map()
        if (err || !stdout) return resolve(map)
        for (const line of stdout.split(/\r?\n/)) {
          // "image.exe","1234","Console","1","12,345 K"
          const m = line.match(/^"([^"]*)","(\d+)"/)
          if (m) map.set(Number(m[2]), m[1])
        }
        resolve(map)
      },
    )
  })
}

/** Listening TCP ports (deduped by port), each with its PID, bind address and
 *  process name. Sorted ascending by port. */
function listListeningPorts() {
  return new Promise((resolve, reject) => {
    execFile(
      'netstat',
      ['-ano', '-p', 'TCP'],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      async (err, stdout) => {
        if (err) return reject(err)
        const byPort = new Map()
        for (const raw of stdout.split(/\r?\n/)) {
          // TCP   0.0.0.0:7777   0.0.0.0:0   LISTENING   12345   (also [::]:7777)
          const m = raw.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
          if (!m) continue
          const port = Number(m[2])
          if (!byPort.has(port)) byPort.set(port, { port, address: m[1], pid: Number(m[3]) })
        }
        const names = await resolveProcessNames()
        const ports = [...byPort.values()]
          .map((e) => ({ ...e, name: names.get(e.pid) || '', isSelf: e.pid === process.pid }))
          .sort((a, b) => a.port - b.port)
        resolve(ports)
      },
    )
  })
}

app.get('/api/ports', async (_req, res) => {
  if (process.platform !== 'win32') {
    res.status(400).json({ error: 'Port listing is only wired for Windows right now' })
    return
  }
  try {
    const ports = await listListeningPorts()
    res.json({ ports })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to list ports' })
  }
})

// Stop the process holding a port, by PID. Refuses to kill this server itself
// or a core system process.
app.post('/api/ports/kill', (req, res) => {
  const pid = Number(req.body?.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    res.status(400).json({ error: 'A valid pid is required' })
    return
  }
  if (pid === process.pid) {
    res.status(400).json({ error: 'Refusing to stop Christopher itself' })
    return
  }
  if (pid === 4) {
    res.status(400).json({ error: 'Refusing to stop a core system process' })
    return
  }
  if (process.platform !== 'win32') {
    res.status(400).json({ error: 'Stopping is only wired for Windows right now' })
    return
  }
  execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }, (err, _stdout, stderr) => {
    if (err) {
      res.status(500).json({ error: (stderr || err.message || 'Could not stop the process').trim() })
      return
    }
    res.json({ ok: true, pid })
  })
})

// List sub-directories of a path for the in-app folder browser. Empty path =>
// the drive list (Windows) or filesystem root. Returns only directories.
app.get('/api/list-dir', async (req, res) => {
  const raw = typeof req.query.path === 'string' ? req.query.path.trim() : ''
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  try {
    if (raw === '') {
      if (process.platform === 'win32') {
        const drives = []
        for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
          const d = `${letter}:\\`
          try {
            await access(d)
            drives.push({ name: `${letter}:\\`, path: d })
          } catch {
            /* drive not present */
          }
        }
        res.json({ path: '', parent: null, entries: drives })
        return
      }
      const ents = await readdir('/', { withFileTypes: true })
      const dirs = ents
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: path.join('/', e.name) }))
        .sort(byName)
      res.json({ path: '/', parent: null, entries: dirs })
      return
    }
    const dir = path.normalize(raw)
    const ents = await readdir(dir, { withFileTypes: true })
    const dirs = ents
      .filter((e) => {
        try {
          return e.isDirectory()
        } catch {
          return false
        }
      })
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort(byName)
    const par = path.dirname(dir)
    res.json({ path: dir, parent: par === dir ? '' : par, entries: dirs })
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Could not read that folder' })
  }
})

// Native folder picker (Windows): opens a FolderBrowserDialog on the user's
// desktop and returns the chosen path (null if cancelled) — legacy fallback.
app.post('/api/pick-directory', (req, res) => {
  if (process.platform !== 'win32') {
    res.status(400).json({ error: 'The folder picker is only available on Windows' })
    return
  }
  const initial = typeof req.body?.initial === 'string' ? req.body.initial.replace(/'/g, "''") : ''
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog;',
    "$f.Description = 'Select a working directory';",
    initial ? `$f.SelectedPath = '${initial}';` : '',
    'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }',
  ].join(' ')
  execFile(
    'powershell.exe',
    ['-NoProfile', '-STA', '-Command', script],
    { windowsHide: true, timeout: 180000 },
    (err, stdout) => {
      if (err && err.killed) {
        res.status(408).json({ error: 'The folder picker timed out' })
        return
      }
      res.json({ path: (stdout || '').trim() || null })
    },
  )
})

// Unregisters the project only — NEVER deletes any files on disk.
app.delete('/api/projects/:id', (req, res) => {
  const project = getProject(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  deleteProject(project.id)
  watchers.close(project.id)
  res.json({ ok: true })
})

app.get('/api/projects/:id/sessions/:sessionId/messages', async (req, res) => {
  const project = getProject(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  const { sessionId } = req.params
  if (!SESSION_ID_RE.test(sessionId)) {
    res.status(400).json({ error: 'Invalid session id' })
    return
  }
  try {
    const messages = await getSessionMessages(project, sessionId)
    if (messages === null) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    res.json({ messages })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to read session messages' })
  }
})

// ---------------------------------------------------------------------------
// Orchestrator — cross-chat context sharing (consumed by orchestrator-mcp.mjs).
// Every endpoint takes a `cwd` (the calling claude process's working dir) and
// resolves it to a registered project, so the MCP tools are automatically
// scoped to the project the chat belongs to.
// ---------------------------------------------------------------------------

// Defense in depth on top of the loopback bind — these routes inject input
// into live terminals, so they must never answer a non-local caller.
function requireLoopback(req, res, next) {
  const a = req.socket.remoteAddress
  if (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') return next()
  res.status(403).json({ error: 'loopback only' })
}
app.use('/api/orchestrator', requireLoopback)

// --- anti-loop guardrails (agent-to-agent messaging is the classic runaway) --
const MAX_RELAY_TEXT = 10000
const FROM_RE = /^[\w.:\-]{1,80}$/
const PAIR_COOLDOWN_MS = 5_000 // one delivery per (from -> target) per 5s
const TARGET_WINDOW_MS = 60_000 // and max…
const TARGET_WINDOW_MAX = 6 // …6 injected messages per target per minute
const BROADCAST_COOLDOWN_MS = 10_000 // one broadcast per project per 10s
const pairLastSent = new Map() // `${from}->${target}` -> ts
const targetRecent = new Map() // target -> ts[]
const broadcastLast = new Map() // projectId -> ts

function relayAllowed(from, targetKey) {
  const now = Date.now()
  if (from) {
    const pairKey = `${from}->${targetKey}`
    const last = pairLastSent.get(pairKey) || 0
    if (now - last < PAIR_COOLDOWN_MS) return 'rate limited: one message per sender per chat per 5s'
    pairLastSent.set(pairKey, now)
  }
  const recent = (targetRecent.get(targetKey) || []).filter((t) => now - t < TARGET_WINDOW_MS)
  if (recent.length >= TARGET_WINDOW_MAX) return 'rate limited: that chat already received 6 messages this minute'
  recent.push(now)
  targetRecent.set(targetKey, recent)
  return null
}

/** does selfKey (`proj::sid`, `proj::new` or `chat:sid`) refer to this target? */
function isSelf(selfKey, projectId, sessionId) {
  if (!selfKey) return false
  const sid = !sessionId || sessionId === 'new' ? 'new' : String(sessionId)
  // a MINTED session id is the SAME conversation wherever its pty runs — exclude
  // it regardless of projectId (a group member can be live under another dir)
  if (sid !== 'new' && selfSessionId(selfKey) === sid) return true
  if (selfKey === `${projectId}::${sid}`) return true // per-directory 'new' pty
  // a chat turn must not message its own conversation's terminal
  if (selfKey.startsWith('chat:') && selfKey.slice(5) === sid) return true
  return false
}

/** parse the caller's session id out of its self key (`proj::sid` | `chat:sid`) */
function selfSessionId(selfKey) {
  const k = String(selfKey || '')
  let sid = ''
  if (k.includes('::')) sid = k.slice(k.indexOf('::') + 2)
  else if (k.startsWith('chat:')) sid = k.slice(5)
  return sid && sid !== 'new' ? sid : null
}

/**
 * Who can this caller see? Its DIRECTORY siblings (live chats in the same cwd
 * project — the original scoping) UNION its PROJECT-GROUP members, which may
 * live in entirely different Claude directories. The caller's identity comes
 * from the `self` key the MCP shim sends on every call. 404 only when the
 * caller has neither a registered directory nor any group membership.
 */
function resolveScope(req, res) {
  const src = req.method === 'GET' ? req.query : req.body || {}
  // AUTHENTICATE by the server-minted token (COS_SESSION_KEY), never by a
  // client-asserted session key / cwd / from — those are all forgeable by any
  // local process, which would defeat the per-chat isolation.
  const identity = identityForToken(String(src.self || ''))
  if (!identity) {
    res.status(403).json({ error: 'unrecognized chat — this call must originate from a live Christopher OS chat' })
    return null
  }
  const dirProject = getProject(identity.projectId) ?? undefined
  const callerSid = identity.sessionId // null for an unminted 'new' chat
  const groups = callerSid ? findGroupsBySession(callerSid) : []
  if (!dirProject && groups.length === 0) {
    res.status(404).json({ error: 'no project for this chat' })
    return null
  }
  const memberIds = new Set()
  for (const g of groups) for (const c of g.chats) memberIds.add(c.sessionId)
  const entries = []
  const bySid = new Map() // minted sid -> index in entries (one pty per conversation)
  for (const s of listLiveSessions(null)) {
    const inDir = dirProject !== undefined && s.projectId === dirProject.id
    const inGroup = s.sessionId !== null && memberIds.has(s.sessionId)
    if (!inDir && !inGroup) continue
    if (s.sessionId !== null && bySid.has(s.sessionId)) {
      // same conversation under two projectIds — keep the on-screen (attached) one
      const i = bySid.get(s.sessionId)
      if (s.attached && !entries[i].attached) entries[i] = s
      continue
    }
    if (s.sessionId !== null) bySid.set(s.sessionId, entries.length)
    entries.push(s)
  }
  // every store this caller can read memory from (all its groups + its directory)
  const scopeIds = [...new Set([...groups.map((g) => g.id), ...(dirProject ? [dirProject.id] : [])])]
  return {
    // the group is the user-facing "project" — it names the scope and owns the
    // shared memory; directory-only chats keep the old per-directory scope
    scopeId: groups.length > 0 ? groups[0].id : dirProject.id,
    scopeName: groups.length > 0 ? groups[0].name : dirProject.name,
    scopeIds,
    dirProject: dirProject ?? null,
    entries,
    // server-derived caller identity (for self-exclusion, rate limits, provenance)
    selfKey: `${identity.projectId}::${callerSid ?? 'new'}`,
    selfLabel: callerSid ? `chat ${callerSid.slice(0, 8)}` : 'a sibling chat',
  }
}

/** find the live pty entry a tool call targets, within the caller's scope */
function findTarget(scope, sessionId) {
  const sid = !sessionId || sessionId === 'new' ? null : String(sessionId)
  if (sid !== null) return scope.entries.find((e) => e.sessionId === sid)
  // 'new' (no minted id) only exists per-directory — target the caller's own dir
  return scope.entries.find(
    (e) => e.sessionId === null && scope.dirProject !== null && e.projectId === scope.dirProject.id,
  )
}

app.get('/api/orchestrator/context', async (req, res) => {
  const scope = resolveScope(req, res)
  if (!scope) return
  // resolve display titles per distinct project (same names the sidebar shows)
  const historyCache = new Map() // shared so global history.jsonl is parsed once
  const titleById = new Map()
  for (const pid of [...new Set(scope.entries.map((e) => e.projectId))]) {
    const proj = getProject(pid)
    if (!proj) continue
    try {
      for (const s of await getSessionsForProject(proj, historyCache)) titleById.set(s.id, s.summary)
    } catch {
      /* fall back to ids below */
    }
  }
  res.json({
    project: {
      id: scope.scopeId,
      name: scope.scopeName,
      fileDir: scope.dirProject?.fileDir || '',
    },
    // list_chats promises the OTHER live chats — never the caller itself
    sessions: scope.entries
      .filter((s) => !isSelf(scope.selfKey, s.projectId, s.sessionId ?? 'new'))
      .map((s) => ({
        sessionId: s.sessionId, // null = fresh session without a minted id yet
        title:
          s.sessionId === null
            ? 'new session'
            : getSessionTitle(s.sessionId) ||
              titleById.get(s.sessionId) ||
              `session ${s.sessionId.slice(0, 8)}`,
        attached: s.attached,
      })),
  })
})

app.get('/api/orchestrator/output', (req, res) => {
  const scope = resolveScope(req, res)
  if (!scope) return
  const sessionId = String(req.query.sessionId || '')
  const lines = Number(req.query.lines) || 100
  const entry = findTarget(scope, sessionId)
  const output = entry ? readSessionOutput(entry.projectId, sessionId, lines) : null
  if (output === null) {
    res.status(404).json({ error: `No live terminal for session ${sessionId || '(empty)'}` })
    return
  }
  res.json({ sessionId: sessionId || 'new', output })
})

app.post('/api/orchestrator/input', (req, res) => {
  const scope = resolveScope(req, res)
  if (!scope) return
  const sessionId = String(req.body?.sessionId || '')
  const text = typeof req.body?.text === 'string' ? req.body.text : ''
  if (!text.trim()) {
    res.status(400).json({ error: 'text is required' })
    return
  }
  if (text.length > MAX_RELAY_TEXT) {
    res.status(413).json({ error: `text too long (max ${MAX_RELAY_TEXT} chars)` })
    return
  }
  const entry = findTarget(scope, sessionId)
  if (!entry) {
    res.status(404).json({ error: `No live terminal for session ${sessionId || '(empty)'}` })
    return
  }
  if (isSelf(scope.selfKey, entry.projectId, sessionId)) {
    res.status(400).json({ error: 'refusing self-delivery: that terminal is this same conversation' })
    return
  }
  const submit = req.body?.submit !== false
  const targetKey = `${entry.projectId}::${entry.sessionId ?? 'new'}`
  const limited = relayAllowed(scope.selfKey, targetKey)
  if (limited) {
    res.status(429).json({ error: limited })
    return
  }
  // provenance envelope (server-stamped, non-forgeable) so the receiving chat
  // knows this came from a sibling AI (raw keystrokes — submit:false — verbatim)
  const payload = submit ? `[message from ${scope.selfLabel}] ${text}` : text
  const ok = writeSessionInput(entry.projectId, sessionId, payload, submit)
  if (!ok) {
    res.status(404).json({ error: `No live terminal for session ${sessionId || '(empty)'}` })
    return
  }
  res.json({ ok: true, sessionId: sessionId || 'new' })
})

app.post('/api/orchestrator/broadcast', (req, res) => {
  const scope = resolveScope(req, res)
  if (!scope) return
  const text = typeof req.body?.text === 'string' ? req.body.text : ''
  if (!text.trim()) {
    res.status(400).json({ error: 'text is required' })
    return
  }
  if (text.length > MAX_RELAY_TEXT) {
    res.status(413).json({ error: `text too long (max ${MAX_RELAY_TEXT} chars)` })
    return
  }
  // one broadcast per scope (group or directory) per cooldown window
  const now = Date.now()
  const last = broadcastLast.get(scope.scopeId) || 0
  if (now - last < BROADCAST_COOLDOWN_MS) {
    res.status(429).json({ error: 'rate limited: one broadcast per project per 10s' })
    return
  }
  broadcastLast.set(scope.scopeId, now)
  const payload = `[broadcast from ${scope.selfLabel}] ${text}`
  const sent = []
  for (const s of scope.entries) {
    const sid = s.sessionId ?? 'new'
    if (isSelf(scope.selfKey, s.projectId, sid)) continue // never echo back to the sender
    // the SAME per-target 6/min cap the input path enforces — so broadcast can't
    // be used to flood a chat by rotating scopes
    if (relayAllowed(scope.selfKey, `${s.projectId}::${sid}`)) continue
    if (writeSessionInput(s.projectId, sid, payload, true)) sent.push(sid)
  }
  res.json({ ok: true, sentTo: sent })
})

app.post('/api/orchestrator/memory/save', async (req, res) => {
  const scope = resolveScope(req, res)
  if (!scope) return
  try {
    const entry = await saveMemory(scope.scopeId, {
      text: req.body?.text,
      tags: req.body?.tags,
      sessionId: req.body?.sessionId,
    })
    res.json({ ok: true, entry })
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Failed to save memory' })
  }
})

// reads span every store the caller can see (its groups + its directory) so
// joining a group never orphans notes saved earlier under the directory scope
async function readMemoryUnion(scope, read) {
  if (scope.scopeIds.length <= 1) return read(scope.scopeId)
  const seen = new Set()
  const merged = []
  for (const id of scope.scopeIds) {
    for (const e of await read(id)) {
      if (e && e.id && !seen.has(e.id)) {
        seen.add(e.id)
        merged.push(e)
      }
    }
  }
  merged.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  return merged
}

app.get('/api/orchestrator/memory/search', async (req, res) => {
  const scope = resolveScope(req, res)
  if (!scope) return
  try {
    const limit = Number(req.query.limit) || 10
    const q = String(req.query.q || '')
    const entries = await readMemoryUnion(scope, (id) => searchMemory(id, q, limit))
    res.json({ entries: entries.slice(0, limit) })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to search memory' })
  }
})

app.get('/api/orchestrator/memory/recent', async (req, res) => {
  const scope = resolveScope(req, res)
  if (!scope) return
  try {
    const limit = Number(req.query.limit) || 10
    const entries = await readMemoryUnion(scope, (id) => recentMemory(id, limit))
    res.json({ entries: entries.slice(0, limit) })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to read memory' })
  }
})

// ---------------------------------------------------------------------------
// WebSockets — single HTTP server, manual upgrade routing
// ---------------------------------------------------------------------------

const server = createServer(app)
const chatWss = new WebSocketServer({ noServer: true })
const terminalWss = new WebSocketServer({ noServer: true })

// Keep terminal sockets alive with a periodic WebSocket ping. An idle socket is
// otherwise dropped by the browser/OS/firewall after ~30-60s of silence, which is
// what surfaces the "Link dropped" / Reconnect button. ping() sends a control frame
// the browser auto-answers with pong; nothing reaches the pty or the app-level
// message handlers, so the terminal stream is undisturbed.
const terminalPingInterval = setInterval(() => {
  for (const ws of terminalWss.clients) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.ping()
      } catch {
        /* socket already closing — its close handler does the cleanup */
      }
    }
  }
}, 25 * 1000)
// never let the heartbeat keep the process alive on its own
if (typeof terminalPingInterval.unref === 'function') terminalPingInterval.unref()

server.on('upgrade', (req, socket, head) => {
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch {
    socket.destroy()
    return
  }
  if (url.pathname === '/ws') {
    chatWss.handleUpgrade(req, socket, head, (ws) => {
      chatWss.emit('connection', ws, req)
    })
  } else if (url.pathname === '/ws/terminal') {
    const projectId = url.searchParams.get('projectId') || ''
    const sessionId = url.searchParams.get('sessionId') || 'new'
    const forceRestart = url.searchParams.get('forceRestart') === '1'
    const cols = Math.floor(Number(url.searchParams.get('cols')))
    const rows = Math.floor(Number(url.searchParams.get('rows')))
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      handleTerminalConnection(ws, { project: getProject(projectId), sessionId, forceRestart, cols, rows })
    })
  } else {
    socket.destroy()
  }
})

// --- chat clients + broadcast (used by the session watchers too) ------------

const chatClients = new Set()

function sendTo(ws, frame) {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      /* socket going away */
    }
  }
}

function broadcast(frame) {
  // Snapshot first: a sendTo that triggers a synchronous close would mutate
  // chatClients mid-iteration. try/catch each so one wedged socket can't abort
  // the fan-out and silently orphan every client after it (which would need a
  // server restart to clear).
  for (const client of [...chatClients]) {
    try {
      sendTo(client, frame)
    } catch {
      /* a wedged socket must never kill the broadcast loop */
    }
  }
}

const watchers = createSessionWatchers({ sessionsDirFor, broadcast })
watchers.sync(listProjects())

// The chat WS is now a READ-ONLY event channel. Clients subscribe to receive
// broadcast frames (chiefly 'sessions-updated', emitted by the session-JSONL
// watcher) so the message viewer can re-read a session's transcript when the
// terminal's claude writes to it. It NO LONGER spawns a claude per message.
//
// This is the core of the 26-engine port: ONE interactive pty per session (see
// terminal.js) is the single claude, shared by the terminal view and the
// read-only message viewer. There is never a second `claude --print --resume`
// racing the pty on the same session id — which was both a resource multiplier
// (a heavyweight claude per chat turn, on top of the persistent pty per session)
// AND a corruption hazard (two processes resuming one session at once). Removing
// it is what makes the app non-terminating no matter how many windows are open.
chatWss.on('connection', (ws) => {
  chatClients.add(ws)

  // Parse-and-ignore: no client frame drives the server anymore. Kept as a
  // no-op so a stray/legacy frame can never crash the socket.
  ws.on('message', () => {})

  ws.on('close', () => {
    chatClients.delete(ws)
  })

  ws.on('error', () => {
    /* close handler does cleanup */
  })
})

// ---------------------------------------------------------------------------
// MCP auto-registration — make the claude-manager tools available to every
// claude this app spawns. Idempotent (`claude mcp get` probe), fire-and-forget,
// and repeated per distinct custom claudeDir (a claude running with a custom
// CLAUDE_CONFIG_DIR reads user-scope MCP config from THAT dir, not ~/.claude).
// ---------------------------------------------------------------------------

const MCP_SHIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'orchestrator-mcp.mjs')

// Reveal a file in the OS file manager (selected). explorer.exe returns exit 1
// even on success, so errors are swallowed.
function revealInOS(filePath) {
  try {
    if (process.platform === 'win32') {
      // open Explorer with the file selected, via a temp .bat so the quoted path
      // can't be mangled (parens/spaces) — same robust trick as openDirInOS
      const win = path.win32.normalize(filePath)
      const stamp = `${process.pid}-${Math.round(process.hrtime()[1])}`
      const bat = path.join(os.tmpdir(), `cos-select-${stamp}.bat`)
      writeFileSync(bat, `@echo off\r\nexplorer /select,"${win}"\r\n`, 'utf8')
      execFile('cmd.exe', ['/c', bat], { windowsHide: true }, () => {})
    } else if (process.platform === 'darwin') {
      execFile('open', ['-R', filePath], () => {})
    } else {
      execFile('xdg-open', [path.dirname(filePath)], () => {})
    }
  } catch {
    /* best effort — the path is still returned to the caller */
  }
}

// Open a directory in the OS file manager (the folder itself, not a selected
// file). explorer.exe returns exit 1 even on success, so errors are swallowed.
function openDirInOS(dirPath) {
  try {
    if (process.platform === 'win32') {
      // Open via a tiny temp .bat that does `start "" "<path>"` — ShellExecute is
      // the canonical, foreground folder-opener, and keeping the path quoted INSIDE
      // the script means parens/spaces (e.g. "Shubham(Code)") can't break parsing.
      const win = path.win32.normalize(dirPath)
      const stamp = `${process.pid}-${Math.round(process.hrtime()[1])}`
      const bat = path.join(os.tmpdir(), `cos-open-${stamp}.bat`)
      writeFileSync(bat, `@echo off\r\nstart "" "${win}"\r\n`, 'utf8')
      execFile('cmd.exe', ['/c', bat], { windowsHide: true }, () => {})
    } else if (process.platform === 'darwin') {
      execFile('open', [dirPath], () => {})
    } else {
      execFile('xdg-open', [dirPath], () => {})
    }
  } catch {
    /* best effort — the path is still returned to the caller */
  }
}

function claudeEnvFor(claudeDir) {
  const env = { ...process.env }
  delete env.CLAUDE_CONFIG_DIR
  if (claudeDir) env.CLAUDE_CONFIG_DIR = claudeDir
  return env
}

function registerMcpInto(claudeDir) {
  const opts = { env: claudeEnvFor(claudeDir), shell: true, windowsHide: true, timeout: 60_000 }
  execFile('claude', ['mcp', 'get', 'claude-manager'], opts, (probeErr) => {
    if (!probeErr) return // already registered in this config dir
    execFile(
      'claude',
      ['mcp', 'add', '--scope', 'user', 'claude-manager', '--', 'node', `"${MCP_SHIM}"`],
      opts,
      (addErr) => {
        const where = claudeDir || 'default ~/.claude'
        if (addErr) console.warn(`[mcp] could not register claude-manager (${where}): ${addErr.message}`)
        else console.log(`[mcp] registered claude-manager MCP (${where})`)
      },
    )
  })
}

function registerMcp() {
  try {
    registerMcpInto(null)
    const customDirs = new Set(
      listProjects()
        .filter((p) => !p.isDefaultClaudeDir)
        .map((p) => p.claudeDir),
    )
    for (const dir of customDirs) registerMcpInto(dir)
  } catch (err) {
    console.warn('[mcp] registration skipped:', err?.message)
  }
}

// Loopback bind: this server can spawn claude with bypassPermissions (chat) and
// inject input into live terminals (orchestrator) — it must never be LAN-reachable.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`claude-manager server on http://localhost:${PORT}`)
  registerMcp()
})

// ---------------------------------------------------------------------------
// Graceful shutdown — reap ptys / claude children, close watchers + sockets
// ---------------------------------------------------------------------------

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(terminalPingInterval)
  watchers.closeAll()
  killAllTerminals()
  for (const client of chatClients) {
    try {
      client.close()
    } catch {
      /* socket going away */
    }
  }
  try {
    chatWss.close()
  } catch {
    /* ignore */
  }
  try {
    terminalWss.close()
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0))
  // Hard stop if something keeps the loop alive (e.g. a stuck child).
  const failsafe = setTimeout(() => process.exit(0), 3000)
  if (typeof failsafe.unref === 'function') failsafe.unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
