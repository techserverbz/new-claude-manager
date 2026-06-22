// Projects store + Claude session discovery / JSONL parsing.
// Mechanics follow the claudecodeui spec: cwd -> folder encoding, history.jsonl
// titles, tail-scan title lines, tolerant per-line JSONL parsing.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const HOME = os.homedir()
export const GLOBAL_CLAUDE_DIR = path.join(HOME, '.claude')

// Session ids are used to build file paths — strict charset, no dots, no separators.
export const SESSION_ID_RE = /^[a-zA-Z0-9-]{1,128}$/
const PROJECT_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(SERVER_ROOT, 'data')
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json')
// User-given session titles (sessionId -> title), overriding the derived summary.
const SESSION_TITLES_FILE = path.join(DATA_DIR, 'session-titles.json')

export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
    this.status = 400
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function normalizeFsPath(input) {
  if (typeof input !== 'string') return ''
  let p = input.trim()
  if (!p) return ''
  // Strip long-path prefixes.
  if (p.startsWith('\\\\?\\UNC\\')) p = '\\\\' + p.slice('\\\\?\\UNC\\'.length)
  else if (p.startsWith('\\\\?\\')) p = p.slice('\\\\?\\'.length)
  const looksWindows =
    process.platform === 'win32' || p.startsWith('\\\\') || /^[a-zA-Z]:([\\/]|$)/.test(p)
  p = looksWindows ? path.win32.normalize(p) : path.posix.normalize(p)
  // Strip trailing separators except filesystem roots (e.g. "C:\").
  if (looksWindows) {
    while (p.length > 3 && (p.endsWith('\\') || p.endsWith('/'))) p = p.slice(0, -1)
  } else {
    while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  }
  return p
}

export function samePath(a, b) {
  const na = normalizeFsPath(a)
  const nb = normalizeFsPath(b)
  if (process.platform === 'win32') return na.toLowerCase() === nb.toLowerCase()
  return na === nb
}

// Claude Code's lossy cwd -> projects folder-name encoding:
// every char that is not [a-zA-Z0-9-] becomes a single '-'. Runs not collapsed.
export function encodeProjectPath(cwd) {
  return normalizeFsPath(cwd).replace(/[^a-zA-Z0-9-]/g, '-')
}

export function sessionsDirFor(project) {
  return path.join(project.claudeDir, 'projects', encodeProjectPath(project.fileDir))
}

// ---------------------------------------------------------------------------
// Persistent store (server/data/projects.json)
// ---------------------------------------------------------------------------

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch {
    /* best effort; save will surface errors */
  }
}

function hydrate(record) {
  if (!record || typeof record !== 'object') return null
  const fileDir = normalizeFsPath(record.fileDir)
  if (!record.id || !fileDir) return null
  const claudeDir = normalizeFsPath(record.claudeDir) || GLOBAL_CLAUDE_DIR
  return {
    id: String(record.id),
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : path.basename(fileDir),
    fileDir,
    claudeDir,
    isDefaultClaudeDir: samePath(claudeDir, GLOBAL_CLAUDE_DIR),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    // hidden "loose" projects: created on demand to open a session from the
    // global list without showing up in the sidebar Projects section.
    ephemeral: record.ephemeral === true,
  }
}

function loadStore() {
  ensureDataDir()
  let raw
  try {
    raw = fs.readFileSync(PROJECTS_FILE, 'utf8')
  } catch {
    return [] // no store yet — first run
  }
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.projects) ? parsed.projects : []
    return list.map(hydrate).filter(Boolean)
  } catch (err) {
    // Corrupted/partial store: preserve the bad file instead of silently
    // returning [] (which the next saveStore() would overwrite, permanently
    // erasing every registered project).
    const backupPath = `${PROJECTS_FILE}.corrupt-${Date.now()}`
    try {
      fs.renameSync(PROJECTS_FILE, backupPath)
      console.error(`projects.json is corrupt (${err?.message}); moved it to ${backupPath}`)
    } catch {
      console.error(`projects.json is corrupt (${err?.message}) and could not be backed up`)
    }
    return []
  }
}

let projects = loadStore()

// Atomic write: temp file + rename so a crash mid-write never truncates the store.
function saveStore() {
  ensureDataDir()
  const tmpPath = `${PROJECTS_FILE}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify({ projects }, null, 2) + '\n', 'utf8')
  fs.renameSync(tmpPath, PROJECTS_FILE)
}

// --- user-given session titles (override the derived summary) ---
function loadTitles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_TITLES_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
let sessionTitles = loadTitles()
function saveTitles() {
  ensureDataDir()
  const tmpPath = `${SESSION_TITLES_FILE}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(sessionTitles, null, 2) + '\n', 'utf8')
  fs.renameSync(tmpPath, SESSION_TITLES_FILE)
}

// Rename a registered project (its display name in the store).
export function renameProject(id, name) {
  const project = getProject(id)
  if (!project) return undefined
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) throw new ValidationError('name is required')
  project.name = trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed
  saveStore()
  return project
}

// Edit a project's name / file directory / Claude directory. Only the fields
// present in `input` change; the rest keep their current values.
export function updateProject(id, input) {
  const project = getProject(id)
  if (!project) return undefined
  const body = input && typeof input === 'object' ? input : {}

  let name = project.name
  if (body.name !== undefined) {
    const t = typeof body.name === 'string' ? body.name.trim() : ''
    if (!t) throw new ValidationError('name is required')
    name = t.length > 120 ? t.slice(0, 120) : t
  }

  let fileDir = project.fileDir
  if (body.fileDir !== undefined) {
    const fd = normalizeFsPath(body.fileDir)
    if (!fd) throw new ValidationError('fileDir is required')
    let stat
    try {
      stat = fs.statSync(fd)
    } catch {
      throw new ValidationError(`fileDir does not exist: ${fd}`)
    }
    if (!stat.isDirectory()) throw new ValidationError(`fileDir is not a directory: ${fd}`)
    fileDir = fd
  }

  let claudeDir = project.claudeDir
  if (body.claudeDir !== undefined) {
    const cdRaw = typeof body.claudeDir === 'string' ? body.claudeDir.trim() : ''
    claudeDir = cdRaw ? normalizeFsPath(cdRaw) : GLOBAL_CLAUDE_DIR
  }
  const isDefaultClaudeDir = samePath(claudeDir, GLOBAL_CLAUDE_DIR)

  if (
    projects.some(
      (p) => p.id !== id && samePath(p.fileDir, fileDir) && samePath(p.claudeDir, claudeDir),
    )
  ) {
    throw new ValidationError('A project with this fileDir and claudeDir is already registered')
  }

  project.name = name
  project.fileDir = fileDir
  project.claudeDir = isDefaultClaudeDir ? GLOBAL_CLAUDE_DIR : claudeDir
  project.isDefaultClaudeDir = isDefaultClaudeDir
  saveStore()
  return project
}

// Delete a session — SOFT delete: rename its .jsonl out of discovery range so it
// vanishes from the list but is recoverable (rename back). Also drops its title.
export async function deleteSession(project, sessionId) {
  if (!SESSION_ID_RE.test(String(sessionId))) throw new ValidationError('invalid sessionId')
  const file = path.join(sessionsDirFor(project), `${sessionId}.jsonl`)
  try {
    await fsp.rename(file, `${file}.deleted-${Date.now()}`)
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err // already gone is fine
  }
  if (sessionTitles[sessionId] !== undefined) {
    delete sessionTitles[sessionId]
    saveTitles()
  }
  return true
}

// Give a session a custom title (empty clears it, reverting to the derived one).
export function renameSession(sessionId, title) {
  if (!SESSION_ID_RE.test(String(sessionId))) throw new ValidationError('invalid sessionId')
  const trimmed = typeof title === 'string' ? title.trim() : ''
  if (!trimmed) {
    delete sessionTitles[sessionId]
  } else {
    sessionTitles[sessionId] = trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed
  }
  saveTitles()
  return sessionTitles[sessionId] || ''
}

export function listProjects() {
  return projects.slice()
}

/**
 * Resolve which registered project a working directory belongs to — the
 * cwd-scoping trick (claude-flow style): an MCP server spawned by the claude
 * CLI inherits claude's cwd, which is the project fileDir or a SUBDIRECTORY
 * of it. Exact match wins; otherwise the deepest fileDir that contains cwd.
 */
export function findProjectByCwd(cwd) {
  const norm = normalizeFsPath(cwd)
  if (!norm) return undefined
  const cmp = process.platform === 'win32' ? norm.toLowerCase() : norm
  let best
  for (const p of projects) {
    const dir = process.platform === 'win32' ? p.fileDir.toLowerCase() : p.fileDir
    const isMatch = cmp === dir || cmp.startsWith(dir + '\\') || cmp.startsWith(dir + '/')
    if (isMatch && (!best || dir.length > (process.platform === 'win32' ? best.fileDir.toLowerCase() : best.fileDir).length)) {
      best = p
    }
  }
  return best
}

/** The user-given title for a session, if any (used by the orchestrator). */
export function getSessionTitle(sessionId) {
  return sessionTitles[String(sessionId)] || ''
}

export function getProject(id) {
  if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) return undefined
  return projects.find((p) => p.id === id)
}

export function createProject(input) {
  const body = input && typeof input === 'object' ? input : {}
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) throw new ValidationError('name is required')

  const fileDir = normalizeFsPath(body.fileDir)
  if (!fileDir) throw new ValidationError('fileDir is required')
  let stat
  try {
    stat = fs.statSync(fileDir)
  } catch {
    throw new ValidationError(`fileDir does not exist: ${fileDir}`)
  }
  if (!stat.isDirectory()) throw new ValidationError(`fileDir is not a directory: ${fileDir}`)

  const claudeDirRaw = typeof body.claudeDir === 'string' ? body.claudeDir.trim() : ''
  const claudeDir = claudeDirRaw ? normalizeFsPath(claudeDirRaw) : GLOBAL_CLAUDE_DIR
  const isDefaultClaudeDir = samePath(claudeDir, GLOBAL_CLAUDE_DIR)

  if (projects.some((p) => samePath(p.fileDir, fileDir) && samePath(p.claudeDir, claudeDir))) {
    throw new ValidationError('A project with this fileDir and claudeDir is already registered')
  }

  const project = {
    id: crypto.randomUUID(),
    name,
    fileDir,
    claudeDir: isDefaultClaudeDir ? GLOBAL_CLAUDE_DIR : claudeDir,
    isDefaultClaudeDir,
    createdAt: new Date().toISOString(),
    ephemeral: false,
  }
  projects.push(project)
  saveStore()
  return project
}

/**
 * Find or create a (possibly hidden) project for an EXACT working directory —
 * used to open a "loose" session from the global list without registering a
 * visible project. Exact fileDir match only: a session must resume in the
 * precise cwd it was created in, never a parent project's directory, or
 * `claude --resume` would look in the wrong encoded folder and miss it.
 */
export function ensureProjectForCwd(cwd, { ephemeral = true } = {}) {
  const fileDir = normalizeFsPath(cwd)
  if (!fileDir) throw new ValidationError('cwd is required')
  let stat
  try {
    stat = fs.statSync(fileDir)
  } catch {
    throw new ValidationError(`directory does not exist: ${fileDir}`)
  }
  if (!stat.isDirectory()) throw new ValidationError(`not a directory: ${fileDir}`)
  const existing = projects.find(
    (p) => samePath(p.fileDir, fileDir) && samePath(p.claudeDir, GLOBAL_CLAUDE_DIR),
  )
  if (existing) return existing
  const project = {
    id: crypto.randomUUID(),
    name: path.basename(fileDir) || fileDir,
    fileDir,
    claudeDir: GLOBAL_CLAUDE_DIR,
    isDefaultClaudeDir: true,
    createdAt: new Date().toISOString(),
    ephemeral: !!ephemeral,
  }
  projects.push(project)
  saveStore()
  return project
}

/** Promote a hidden loose project into a normal, sidebar-visible project. */
export function pinProject(id) {
  const project = getProject(id)
  if (!project) return undefined
  if (project.ephemeral) {
    project.ephemeral = false
    saveStore()
  }
  return project
}

// Unregisters only — never touches any files on disk.
export function deleteProject(id) {
  const before = projects.length
  projects = projects.filter((p) => p.id !== id)
  if (projects.length === before) return false
  saveStore()
  return true
}

// ---------------------------------------------------------------------------
// JSONL helpers
// ---------------------------------------------------------------------------

function parseLines(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // torn/partial lines from concurrent writes — skip silently
    }
  }
  return out
}

/** True when the LAST non-empty line of `text` is not valid JSON — i.e. the shell
    caught the file mid-append. parseLines would silently drop that line, so the
    message count momentarily reads one short (N-1), which makes the chat history
    "flicker"/toggle. We use this to re-read once and let the write settle. */
function hasTornFinalLine(text) {
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed === '') continue
    try {
      JSON.parse(trimmed)
      return false
    } catch {
      return true
    }
  }
  return false
}

/** Read a session transcript, tolerating a torn final line. The interactive shell
    holds the JSONL open and appends incrementally; a concurrent read can land
    mid-write. If the last line is partial, wait a beat and re-read once so the
    count doesn't oscillate N↔N-1 between polls. */
async function readSessionTextStable(filePath) {
  let text = await fsp.readFile(filePath, 'utf8')
  if (hasTornFinalLine(text)) {
    await new Promise((r) => setTimeout(r, 40))
    text = await fsp.readFile(filePath, 'utf8')
  }
  return text
}

const ANSI_RE = new RegExp("[\\u001B\\u009B][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]", 'g')
function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '')
}

const INTERNAL_PREFIXES = ['<system-reminder>', 'Caveat:', '[Request interrupted']
function isInternalText(text) {
  return INTERNAL_PREFIXES.some((p) => text.startsWith(p))
}

function normalizeSummary(value) {
  if (typeof value !== 'string') return ''
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > 120 ? collapsed.slice(0, 120) : collapsed
}

// history.jsonl: sessionId -> display (first-seen wins = the user's first prompt)
async function getHistoryTitleMap(claudeDir, cache) {
  const key = process.platform === 'win32' ? normalizeFsPath(claudeDir).toLowerCase() : normalizeFsPath(claudeDir)
  if (cache.has(key)) return cache.get(key)
  const map = new Map()
  try {
    const text = await fsp.readFile(path.join(claudeDir, 'history.jsonl'), 'utf8')
    for (const entry of parseLines(text)) {
      if (entry && typeof entry.sessionId === 'string' && typeof entry.display === 'string' && !map.has(entry.sessionId)) {
        map.set(entry.sessionId, entry.display)
      }
    }
  } catch {
    // no history file — fine
  }
  cache.set(key, map)
  return map
}

// Tail-scan a session transcript for title lines.
function titleFromEntries(entries, sessionId) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (!e || typeof e !== 'object') continue
    if (e.sessionId && e.sessionId !== sessionId) continue
    if (e.type === 'ai-title' || e.type === 'last-prompt' || e.type === 'custom-title') {
      const title = e.aiTitle || e.lastPrompt || e.customTitle
      if (typeof title === 'string' && title.trim()) return title
    }
    if (e.type === 'summary' && typeof e.summary === 'string' && e.summary.trim()) {
      return e.summary
    }
  }
  return ''
}

// Cheap message tally for big browse lists: count transcript lines that carry a
// user/assistant message WITHOUT JSON.parsing every line (the real cost on huge
// sessions). Approximate (may include meta/split lines) but keeps scans snappy.
function countMessagesFast(text) {
  let n = 0
  let i = 0
  for (;;) {
    const u = text.indexOf('"type":"user"', i)
    const a = text.indexOf('"type":"assistant"', i)
    if (u === -1 && a === -1) break
    if (u !== -1 && (a === -1 || u < a)) {
      n++
      i = u + 13
    } else {
      n++
      i = a + 18
    }
  }
  return n
}

// Accurate count for normal files; fast approximate for very large ones so a
// folder full of huge transcripts (e.g. a home-dir project) never hangs.
const FAST_COUNT_BYTES = 400_000
function countMessagesSizeAware(text, sessionId) {
  if (text.length > FAST_COUNT_BYTES) return countMessagesFast(text)
  return countMessages(parseLines(text), sessionId)
}

// Never read more than this from a transcript when scanning for a list — some
// sessions reach hundreds of MB and reading them whole stalls/OOMs the process.
// Past the cap we read only the head (cwd + first messages live there) and scale
// the count by size, so a giant file costs ~one cheap read, not its full weight.
const SCAN_CAP_BYTES = 1_500_000
async function readForScan(filePath, size) {
  if (size <= SCAN_CAP_BYTES) {
    return { text: await fsp.readFile(filePath, 'utf8'), truncated: false }
  }
  const fh = await fsp.open(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(SCAN_CAP_BYTES)
    const { bytesRead } = await fh.read(buf, 0, SCAN_CAP_BYTES, 0)
    return { text: buf.toString('utf8', 0, bytesRead), truncated: true }
  } finally {
    await fh.close()
  }
}

// First cwd recorded in a transcript, via a cheap regex (no full parse).
function cwdFromText(text) {
  const m = text.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (!m) return ''
  try {
    return JSON.parse('"' + m[1] + '"').trim()
  } catch {
    return m[1].replace(/\\\\/g, '\\').trim()
  }
}

function countMessages(entries, sessionId) {
  let count = 0
  const seenAssistantIds = new Set()
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    if (e.sessionId !== sessionId) continue
    if (e.isMeta === true) continue
    if (!e.message || typeof e.message !== 'object') continue
    if (e.type === 'user') {
      const c = e.message.content
      const hasText =
        typeof c === 'string'
          ? c.trim().length > 0 && !isInternalText(c)
          : Array.isArray(c) && c.some((p) => p && p.type === 'text' && typeof p.text === 'string' && !isInternalText(p.text))
      if (hasText) count++
    } else if (e.type === 'assistant') {
      // One API message can be split across several lines sharing message.id.
      const mid = e.message.id
      if (typeof mid === 'string') {
        if (seenAssistantIds.has(mid)) continue
        seenAssistantIds.add(mid)
      }
      count++
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

export async function getSessionsForProject(project, historyCache = new Map()) {
  const dir = sessionsDirFor(project)
  let names
  try {
    names = await fsp.readdir(dir)
  } catch {
    return [] // no sessions yet for this project
  }
  const historyMap = await getHistoryTitleMap(project.claudeDir, historyCache)
  const sessions = []
  for (const fileName of names) {
    if (!fileName.endsWith('.jsonl')) continue
    if (fileName.startsWith('agent-')) continue // subagent sidechain transcripts
    const sessionId = fileName.slice(0, -'.jsonl'.length)
    if (!SESSION_ID_RE.test(sessionId)) continue
    const filePath = path.join(dir, fileName)
    let stat
    try {
      stat = await fsp.stat(filePath)
    } catch {
      continue
    }
    let summary = sessionTitles[sessionId] || historyMap.get(sessionId) || ''
    let messageCount = 0
    try {
      const { text, truncated } = await readForScan(filePath, stat.size)
      messageCount = countMessagesSizeAware(text, sessionId)
      if (truncated && text.length > 0) {
        messageCount = Math.round((messageCount * stat.size) / text.length) // scale the head count
      }
      // only the (expensive) full parse for a title when we still need one and
      // the file is a sane size — huge transcripts fall back to history/Untitled
      if (!summary && !truncated && text.length <= FAST_COUNT_BYTES) {
        summary = titleFromEntries(parseLines(text), sessionId)
      }
    } catch {
      // unreadable file — list it with what we have
    }
    sessions.push({
      id: sessionId,
      summary: normalizeSummary(summary) || 'Untitled session',
      lastActive: stat.mtime.toISOString(),
      messageCount,
    })
  }
  // newest first
  sessions.sort((a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : a.id < b.id ? 1 : -1))
  return sessions
}

/**
 * Discover the directories Claude has already worked in — every folder under
 * <globalClaudeDir>/projects/. The folder names are lossy-encoded, so the REAL
 * working directory is recovered from the `cwd` field inside a session JSONL.
 * Returns the real fileDir + a suggested name + session count, newest first,
 * with a flag for ones already registered as a project.
 */
export async function discoverProjects() {
  const dir = path.join(GLOBAL_CLAUDE_DIR, 'projects')
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s)
  const registered = new Set(projects.map((p) => fold(normalizeFsPath(p.fileDir))))
  const out = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const folderPath = path.join(dir, ent.name)
    let names
    try {
      names = await fsp.readdir(folderPath)
    } catch {
      continue
    }
    const jsonls = names.filter((n) => n.endsWith('.jsonl') && !n.startsWith('agent-'))
    if (jsonls.length === 0) continue
    // recover the cwd from the first readable session; track newest mtime
    let cwd = ''
    let lastActive = 0
    for (const fn of jsonls) {
      const fp = path.join(folderPath, fn)
      try {
        const st = await fsp.stat(fp)
        if (st.mtimeMs > lastActive) lastActive = st.mtimeMs
        if (!cwd) {
          const text = await fsp.readFile(fp, 'utf8')
          for (const line of text.split(/\r?\n/)) {
            const t = line.trim()
            if (!t) continue
            try {
              const e = JSON.parse(t)
              if (typeof e.cwd === 'string' && e.cwd.trim()) {
                cwd = e.cwd.trim()
                break
              }
            } catch {
              /* torn line */
            }
          }
        }
      } catch {
        /* unreadable */
      }
    }
    if (!cwd) continue // can't recover the real path — skip (encoding is lossy)
    out.push({
      fileDir: cwd,
      name: path.basename(normalizeFsPath(cwd)) || cwd,
      sessionCount: jsonls.length,
      lastActive: new Date(lastActive).toISOString(),
      registered: registered.has(fold(normalizeFsPath(cwd))),
    })
  }
  out.sort((a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : 0))
  return out
}

export async function listProjectsWithSessions() {
  const historyCache = new Map()
  const out = []
  for (const project of projects) {
    out.push({ ...project, sessions: await getSessionsForProject(project, historyCache) })
  }
  return out
}

/**
 * Every Claude session JSONL on this machine — a flat, newest-first index that
 * spans ALL folders under <globalClaudeDir>/projects, whether or not the folder
 * is a registered project. Each row carries its recovered real cwd plus the
 * registered project (id+name) that owns that cwd, if any (null = "loose").
 */
// --- content search across session transcripts ------------------------------
// A lowercased, searchable blob of just the human/assistant message text (and
// tool-result text) from parsed transcript entries — drops JSON noise so a query
// matches words people actually wrote, not keys like "type"/"assistant".
function sessionSearchBlob(entries) {
  const parts = []
  for (const e of entries) {
    if (!e || typeof e !== 'object' || !e.message || typeof e.message !== 'object') continue
    const content = e.message.content
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        if (typeof block.text === 'string') parts.push(block.text)
        else if (typeof block.content === 'string') parts.push(block.content)
      }
    }
  }
  return stripAnsi(parts.join('\n'))
}

// Cache the extracted blob per file, keyed by mtime+size, so repeated searches
// (i.e. typing) never re-read/re-parse an unchanged transcript.
const searchBlobCache = new Map() // filePath -> { mtimeMs, size, blob }
const SEARCH_CACHE_MAX = 2000
async function blobForFile(filePath, stat) {
  const cached = searchBlobCache.get(filePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.blob
  const { text } = await readForScan(filePath, stat.size)
  const blob = sessionSearchBlob(parseLines(text))
  if (searchBlobCache.size >= SEARCH_CACHE_MAX) searchBlobCache.clear()
  searchBlobCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, blob })
  return blob
}

function snippetFor(blob, qLower, span = 60) {
  const idx = blob.toLowerCase().indexOf(qLower)
  if (idx === -1) return ''
  const start = Math.max(0, idx - span)
  const end = Math.min(blob.length, idx + qLower.length + span)
  let s = blob.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) s = '… ' + s
  if (end < blob.length) s = s + ' …'
  return s
}

// Search transcript CONTENT for `query`. Optionally restrict to a set of session
// ids (the Projects tab passes its members); otherwise scans every session on
// the machine. Returns matching session ids + a short snippet. Reads are capped
// (readForScan) and cached, so even huge transcripts stay cheap.
export async function searchSessionContent(query, { sessionIds = null, limit = 500 } = {}) {
  const qLower = String(query || '')
    .trim()
    .toLowerCase()
  if (qLower.length < 2) return []
  const idSet = Array.isArray(sessionIds) && sessionIds.length ? new Set(sessionIds) : null
  const dir = path.join(GLOBAL_CLAUDE_DIR, 'projects')
  let folders
  try {
    folders = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const ent of folders) {
    if (!ent.isDirectory()) continue
    const folderPath = path.join(dir, ent.name)
    let names
    try {
      names = await fsp.readdir(folderPath)
    } catch {
      continue
    }
    for (const fileName of names) {
      if (!fileName.endsWith('.jsonl') || fileName.startsWith('agent-')) continue
      const sessionId = fileName.slice(0, -'.jsonl'.length)
      if (!SESSION_ID_RE.test(sessionId)) continue
      if (idSet && !idSet.has(sessionId)) continue
      const filePath = path.join(folderPath, fileName)
      let stat
      try {
        stat = await fsp.stat(filePath)
      } catch {
        continue
      }
      try {
        const blob = await blobForFile(filePath, stat)
        if (blob.toLowerCase().includes(qLower)) {
          out.push({ sessionId, snippet: snippetFor(blob, qLower) })
          if (out.length >= limit) return out
        }
      } catch {
        /* unreadable — skip */
      }
    }
  }
  return out
}

// Find a session jsonl by id under a Claude "projects" directory (default the
// global ~/.claude/projects) and recover its cwd from the transcript — powers
// "Add chat → By ID". A given path is tried as-is and with a /projects suffix,
// so either ".../.claude" or ".../.claude/projects" works.
export async function resolveSessionById(sessionId, projectsDir) {
  if (!SESSION_ID_RE.test(String(sessionId))) return null
  const candidates = []
  const norm = normalizeFsPath(projectsDir)
  if (norm) {
    candidates.push(norm)
    if (!/[\\/]projects$/i.test(norm)) candidates.push(path.join(norm, 'projects'))
  } else {
    candidates.push(path.join(GLOBAL_CLAUDE_DIR, 'projects'))
  }
  for (const dir of candidates) {
    let folders
    try {
      folders = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of folders) {
      if (!ent.isDirectory()) continue
      const filePath = path.join(dir, ent.name, `${sessionId}.jsonl`)
      let stat
      try {
        stat = await fsp.stat(filePath)
      } catch {
        continue
      }
      try {
        const { text } = await readForScan(filePath, stat.size)
        const cwd = cwdFromText(text)
        return { sessionId, cwd: cwd ? normalizeFsPath(cwd) : '', folder: ent.name }
      } catch {
        return { sessionId, cwd: '', folder: ent.name }
      }
    }
  }
  return null
}

// Move a session transcript to a DIFFERENT working directory: relocate its
// .jsonl from <claudeDir>/projects/<enc(fromCwd)> to <enc(toCwd)> so Claude
// resumes it in the new directory. The file is moved as-is (its internal cwd
// references are left intact — historical). Powers per-chat "Change directory".
export async function moveSession(sessionId, fromCwd, toCwd, claudeDir) {
  if (!SESSION_ID_RE.test(String(sessionId))) throw new ValidationError('invalid sessionId')
  const from = normalizeFsPath(fromCwd)
  const to = normalizeFsPath(toCwd)
  if (!from) throw new ValidationError('source directory is required')
  if (!to) throw new ValidationError('target directory is required')
  if (samePath(from, to)) throw new ValidationError('the target is the same directory')
  const projectsRoot = path.join(normalizeFsPath(claudeDir) || GLOBAL_CLAUDE_DIR, 'projects')
  const src = path.join(projectsRoot, encodeProjectPath(from), `${sessionId}.jsonl`)
  const destDir = path.join(projectsRoot, encodeProjectPath(to))
  const dest = path.join(destDir, `${sessionId}.jsonl`)
  try {
    await fsp.access(src)
  } catch {
    throw new ValidationError('the session file was not found in the source directory')
  }
  // refuse to clobber an existing transcript at the destination
  let destExists = true
  try {
    await fsp.access(dest)
  } catch {
    destExists = false
  }
  if (destExists) throw new ValidationError('a session with this id already exists in the target directory')
  await fsp.mkdir(destDir, { recursive: true })
  try {
    await fsp.rename(src, dest)
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      // cross-device move: copy then remove
      await fsp.copyFile(src, dest)
      await fsp.unlink(src)
    } else {
      throw err
    }
  }
  return { sessionId: String(sessionId), cwd: to, folder: encodeProjectPath(to) }
}

export async function listAllSessions() {
  const dir = path.join(GLOBAL_CLAUDE_DIR, 'projects')
  let folders
  try {
    folders = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s)
  const registeredByDir = new Map()
  for (const p of projects) {
    if (p.ephemeral) continue // loose projects don't count as "owning" a folder
    registeredByDir.set(fold(normalizeFsPath(p.fileDir)), { id: p.id, name: p.name })
  }
  const historyMap = await getHistoryTitleMap(GLOBAL_CLAUDE_DIR, new Map())
  const out = []
  for (const ent of folders) {
    if (!ent.isDirectory()) continue
    const folderPath = path.join(dir, ent.name)
    let names
    try {
      names = await fsp.readdir(folderPath)
    } catch {
      continue
    }
    const jsonls = names.filter((n) => n.endsWith('.jsonl') && !n.startsWith('agent-'))
    if (jsonls.length === 0) continue
    let folderCwd = '' // all sessions in a folder share the same cwd; recover once
    for (const fileName of jsonls) {
      const sessionId = fileName.slice(0, -'.jsonl'.length)
      if (!SESSION_ID_RE.test(sessionId)) continue
      const filePath = path.join(folderPath, fileName)
      let stat
      try {
        stat = await fsp.stat(filePath)
      } catch {
        continue
      }
      let summary = sessionTitles[sessionId] || historyMap.get(sessionId) || ''
      let messageCount = 0
      let fileCwd = ''
      try {
        const { text, truncated } = await readForScan(filePath, stat.size)
        messageCount = countMessagesSizeAware(text, sessionId)
        if (truncated && text.length > 0) {
          messageCount = Math.round((messageCount * stat.size) / text.length)
        }
        fileCwd = cwdFromText(text)
        if (!summary && !truncated && text.length <= FAST_COUNT_BYTES) {
          summary = titleFromEntries(parseLines(text), sessionId)
        }
      } catch {
        /* unreadable — list with what we have */
      }
      if (fileCwd && !folderCwd) folderCwd = fileCwd
      const cwd = fileCwd || folderCwd
      const normCwd = cwd ? normalizeFsPath(cwd) : ''
      const reg = normCwd ? registeredByDir.get(fold(normCwd)) : undefined
      out.push({
        sessionId,
        summary: normalizeSummary(summary) || 'Untitled session',
        lastActive: stat.mtime.toISOString(),
        messageCount,
        cwd: normCwd,
        folder: ent.name,
        projectId: reg ? reg.id : null,
        projectName: reg ? reg.name : null,
      })
    }
  }
  out.sort((a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : 0))
  return out
}

// ---------------------------------------------------------------------------
// Transcript -> UI messages: [{ id, role, content, timestamp, toolUse? }]
// ---------------------------------------------------------------------------

export async function getSessionMessages(project, sessionId) {
  if (!SESSION_ID_RE.test(String(sessionId))) return null
  const filePath = path.join(sessionsDirFor(project), `${sessionId}.jsonl`)
  let text
  try {
    text = await readSessionTextStable(filePath)
  } catch {
    return null // session not found
  }

  const entries = parseLines(text).filter((e) => e && typeof e === 'object' && e.sessionId === sessionId)
  const messages = []
  let generated = 0
  const nextId = (entry) => (typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `gen-${++generated}`)

  for (const entry of entries) {
    const msg = entry.message
    if (!msg || typeof msg !== 'object') continue
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : new Date(0).toISOString()

    if (entry.type === 'user' && msg.role === 'user') {
      if (entry.isMeta === true) continue
      const content = msg.content

      if (typeof content === 'string') {
        if (!content.trim()) continue
        if (entry.isCompactSummary === true) {
          messages.push({ id: nextId(entry), role: 'assistant', content, timestamp, toolUse: undefined })
          continue
        }
        if (content.includes('<command-name>')) {
          const name = (content.match(/<command-name>([\s\S]*?)<\/command-name>/) || [])[1]?.trim() || ''
          const args = (content.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1]?.trim() || ''
          const textOut = `${name} ${args}`.trim()
          if (textOut) messages.push({ id: nextId(entry), role: 'user', content: textOut, timestamp, toolUse: undefined })
          continue
        }
        if (content.includes('<local-command-stdout>')) {
          const out = stripAnsi((content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/) || [])[1] || '').trim()
          if (out) messages.push({ id: nextId(entry), role: 'assistant', content: out, timestamp, toolUse: undefined })
          continue
        }
        if (isInternalText(content)) continue
        messages.push({ id: nextId(entry), role: 'user', content, timestamp, toolUse: undefined })
        continue
      }

      if (Array.isArray(content)) {
        // tool_result parts are rendered inline with the tool call on the FE — skip here.
        const texts = content
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string' && p.text.trim() && !isInternalText(p.text))
          .map((p) => p.text)
        if (texts.length) {
          messages.push({ id: nextId(entry), role: 'user', content: texts.join('\n\n'), timestamp, toolUse: undefined })
        }
        continue
      }
      continue
    }

    if (entry.type === 'assistant' && msg.role === 'assistant') {
      const parts = Array.isArray(msg.content) ? msg.content : []
      const texts = []
      const toolUse = []
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) texts.push(part.text)
        else if (part.type === 'tool_use') toolUse.push({ name: String(part.name ?? ''), input: part.input })
        // thinking blocks intentionally omitted from the UI payload
      }
      if (texts.length === 0 && toolUse.length === 0) continue
      messages.push({
        id: nextId(entry),
        role: 'assistant',
        content: texts.join('\n\n'),
        timestamp,
        toolUse: toolUse.length ? toolUse : undefined,
      })
    }
  }

  // Stable chronological sort (file order is already ~chronological).
  return messages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ta = Date.parse(a.m.timestamp) || 0
      const tb = Date.parse(b.m.timestamp) || 0
      return ta - tb || a.i - b.i
    })
    .map((x) => x.m)
}
